import {
  Controller,
  Get,
  Query,
  Param,
  Res,
  UseGuards,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { ChannelType } from '@prisma/client';
import { Public, CurrentOrg } from '../../../../common/decorators';
import { JwtAuthGuard, OrgGuard } from '../../../../common/guards';
import { PrismaService } from '../../../../database/prisma.service';
import { ShopeeOAuthService } from './shopee.oauth.service';

/**
 * Conexão OAuth do Shopee (Open Platform v2).
 * 1. Front (autenticado) chama GET /authorize-url?channelId= → recebe a URL
 *    e redireciona o lojista pro consentimento no Shopee.
 * 2. Shopee redireciona pro GET /callback/:channelId?code=&shop_id= (público)
 *    → troca o code por tokens (guarda shop_id) e volta pro app.
 *
 * Shopee não repassa um `state` livre, então codificamos o channelId no PATH
 * do redirect_uri (o Shopee só anexa ?code=&shop_id= ao final).
 */
@ApiTags('Integrations')
@Controller('integrations/shopee/oauth')
export class ShopeeOAuthController {
  private readonly logger = new Logger(ShopeeOAuthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: ShopeeOAuthService,
    private readonly config: ConfigService,
  ) {}

  private redirectUri(channelId: string): string {
    const appUrl = (this.config.get<string>('APP_URL') || '').replace(/\/$/, '');
    return `${appUrl}/api/v1/integrations/shopee/oauth/callback/${channelId}`;
  }

  @Get('authorize-url')
  @ApiBearerAuth()
  @UseGuards(JwtAuthGuard, OrgGuard)
  @ApiOperation({ summary: 'URL de consentimento OAuth do Shopee' })
  async authorizeUrl(
    @CurrentOrg('id') organizationId: string,
    @Query('channelId') channelId: string,
  ): Promise<{ url: string }> {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, organizationId, type: ChannelType.SHOPEE },
    });
    if (!channel) throw new NotFoundException('Canal Shopee não encontrado');
    const url = this.oauth.buildAuthUrl(this.redirectUri(channelId));
    return { url };
  }

  @Get('callback/:channelId')
  @Public()
  @ApiOperation({ summary: 'Callback OAuth do Shopee' })
  async callback(
    @Param('channelId') channelId: string,
    @Query('code') code: string,
    @Query('shop_id') shopId: string,
    @Res() res: Response,
  ): Promise<void> {
    const webUrl = (this.config.get<string>('CORS_ORIGIN') || '').replace(/\/$/, '');
    const done = (q: string) => res.redirect(`${webUrl}/settings/channels?${q}`);
    try {
      if (!code || !shopId) throw new Error('code/shop_id ausentes');
      const channel = await this.prisma.channel.findUnique({
        where: { id: channelId },
      });
      if (!channel || channel.type !== ChannelType.SHOPEE) {
        throw new Error('canal Shopee não encontrado');
      }
      await this.oauth.exchangeCode(channel, code, shopId);
      this.logger.log(`OAuth Shopee conectado: canal ${channelId} shop ${shopId}`);
      return done('shopee=connected');
    } catch (err: any) {
      this.logger.error(`Callback OAuth Shopee falhou: ${err.message}`);
      return done('shopee=error');
    }
  }

  /**
   * Desautorização: o Shopee chama esta URL quando a loja REMOVE o app,
   * enviando `shop_id`. Marcamos o canal correspondente como desconectado
   * (limpa tokens + desativa) pra não tentar mais usar credenciais mortas.
   */
  @Get('deauth')
  @Public()
  @ApiOperation({ summary: 'Callback de desautorização do Shopee' })
  async deauth(
    @Query('shop_id') shopId: string,
    @Res() res: Response,
  ): Promise<void> {
    const webUrl = (this.config.get<string>('CORS_ORIGIN') || '').replace(/\/$/, '');
    try {
      if (shopId) {
        // Filtro JSON no código (Prisma JSON path é frágil quando a chave falta).
        const channels = await this.prisma.channel.findMany({
          where: { type: ChannelType.SHOPEE, deletedAt: null },
        });
        for (const ch of channels) {
          const cfg = (ch.config ?? {}) as Record<string, any>;
          if (String(cfg.shopId ?? '') === String(shopId)) {
            await this.prisma.channel.update({
              where: { id: ch.id },
              data: {
                isActive: false,
                config: {
                  ...cfg,
                  accessToken: null,
                  refreshToken: null,
                  deauthorizedAt: new Date().toISOString(),
                },
              },
            });
            this.logger.log(
              `Shopee shop ${shopId} desautorizou — canal ${ch.id} desativado`,
            );
          }
        }
      }
    } catch (err: any) {
      this.logger.error(`Deauth Shopee falhou: ${err.message}`);
    }
    res.redirect(`${webUrl}/settings/channels?shopee=deauthorized`);
  }
}
