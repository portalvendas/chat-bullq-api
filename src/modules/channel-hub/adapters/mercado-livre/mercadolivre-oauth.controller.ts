import {
  Controller,
  Get,
  Query,
  Res,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { Response } from 'express';
import { ChannelType } from '@prisma/client';
import { Public, CurrentOrg } from '../../../../common/decorators';
import { PrismaService } from '../../../../database/prisma.service';
import { MercadoLivreOAuthService } from './mercadolivre.oauth.service';

/**
 * Fluxo de conexão OAuth do Mercado Livre.
 * 1. Front (autenticado) chama GET /authorize-url?channelId= → recebe a URL e
 *    redireciona o vendedor pro consentimento no ML.
 * 2. ML redireciona pro GET /callback?code=&state=channelId (público) → troca
 *    o code por tokens e salva no canal, depois volta pro app.
 */
@ApiTags('Integrations')
@Controller('integrations/mercado-livre/oauth')
export class MercadoLivreOAuthController {
  private readonly logger = new Logger(MercadoLivreOAuthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: MercadoLivreOAuthService,
    private readonly config: ConfigService,
  ) {}

  private redirectUri(): string {
    const appUrl = (this.config.get<string>('APP_URL') || '').replace(/\/$/, '');
    return `${appUrl}/api/v1/integrations/mercado-livre/oauth/callback`;
  }

  @Get('authorize-url')
  @ApiOperation({ summary: 'URL de consentimento OAuth do Mercado Livre' })
  async authorizeUrl(
    @CurrentOrg('id') organizationId: string,
    @Query('channelId') channelId: string,
  ): Promise<{ url: string }> {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, organizationId, type: ChannelType.MERCADO_LIVRE },
    });
    if (!channel) throw new NotFoundException('Canal Mercado Livre não encontrado');
    const cfg = (channel.config ?? {}) as Record<string, any>;
    if (!cfg.clientId) {
      throw new NotFoundException('Canal sem clientId configurado');
    }
    const url = this.oauth.buildAuthUrl(cfg.clientId, this.redirectUri(), channelId);
    return { url };
  }

  @Get('callback')
  @Public()
  @ApiOperation({ summary: 'Callback OAuth do Mercado Livre' })
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ): Promise<void> {
    const webUrl = (this.config.get<string>('CORS_ORIGIN') || '').replace(/\/$/, '');
    const done = (q: string) => res.redirect(`${webUrl}/settings/channels?${q}`);
    try {
      if (!code || !state) throw new Error('code/state ausentes');
      const channel = await this.prisma.channel.findUnique({ where: { id: state } });
      if (!channel) throw new Error('canal do state não encontrado');
      const cfg = (channel.config ?? {}) as Record<string, any>;
      const data = await this.oauth.exchangeCode(
        cfg.clientId,
        cfg.clientSecret,
        code,
        this.redirectUri(),
      );
      await this.oauth.persistTokens(channel.id, cfg, data);
      this.logger.log(`OAuth ML conectado: canal ${channel.id} seller ${data.user_id}`);
      return done('ml=connected');
    } catch (err: any) {
      this.logger.error(`Callback OAuth ML falhou: ${err.message}`);
      return done('ml=error');
    }
  }
}
