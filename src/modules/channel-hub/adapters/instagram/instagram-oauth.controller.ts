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
import { InstagramOAuthService } from './instagram.oauth.service';

/**
 * Conexão OAuth do Instagram (Instagram Login).
 * 1. Front (autenticado) chama GET /authorize-url?channelId= -> URL de consentimento.
 * 2. Instagram redireciona pro GET /callback?code=&state=channelId (público) ->
 *    troca por token longo, persiste no canal e volta pro app.
 */
@ApiTags('Integrations')
@Controller('integrations/instagram/oauth')
export class InstagramOAuthController {
  private readonly logger = new Logger(InstagramOAuthController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly oauth: InstagramOAuthService,
    private readonly config: ConfigService,
  ) {}

  private redirectUri(): string {
    const appUrl = (this.config.get<string>('APP_URL') || '').replace(/\/$/, '');
    return `${appUrl}/api/v1/integrations/instagram/oauth/callback`;
  }

  @Get('authorize-url')
  @ApiOperation({ summary: 'URL de consentimento OAuth do Instagram' })
  async authorizeUrl(
    @CurrentOrg('id') organizationId: string,
    @Query('channelId') channelId: string,
  ): Promise<{ url: string }> {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, organizationId, type: ChannelType.INSTAGRAM },
    });
    if (!channel) throw new NotFoundException('Canal Instagram não encontrado');
    const url = this.oauth.buildAuthUrl(this.redirectUri(), channelId);
    return { url };
  }

  @Get('callback')
  @Public()
  @ApiOperation({ summary: 'Callback OAuth do Instagram' })
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error: string,
    @Res() res: Response,
  ): Promise<void> {
    const webUrl = (this.config.get<string>('CORS_ORIGIN') || '')
      .split(',')[0]
      .trim()
      .replace(/\/$/, '');
    const done = (q: string) => res.redirect(`${webUrl}/settings/channels?${q}`);
    try {
      if (error) throw new Error(`consentimento negado: ${error}`);
      if (!code || !state) throw new Error('code/state ausentes');
      // state = channelId. Valida que existe e é INSTAGRAM (evita usar o code
      // pra um canal de outro tipo/inexistente).
      const channel = await this.prisma.channel.findUnique({
        where: { id: state },
      });
      if (!channel || channel.type !== ChannelType.INSTAGRAM) {
        throw new Error('canal do state inválido');
      }
      const cfg = (channel.config ?? {}) as Record<string, any>;
      const short = await this.oauth.exchangeCode(code, this.redirectUri());
      const long = await this.oauth.exchangeForLongLived(short.access_token);
      await this.oauth.persistTokens(channel.id, cfg, {
        accessToken: long.access_token,
        userId: short.user_id,
        expiresIn: long.expires_in,
      });
      this.logger.log(
        `OAuth Instagram conectado: canal ${channel.id} ig_user ${short.user_id}`,
      );
      return done('ig=connected');
    } catch (err: any) {
      this.logger.error(`Callback OAuth Instagram falhou: ${err.message}`);
      return done('ig=error');
    }
  }
}
