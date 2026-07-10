import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import axios from 'axios';
import { PrismaService } from '../../../../database/prisma.service';

/**
 * OAuth2 do Mercado Livre (Authorization Code + refresh rotativo).
 *
 * `channel.config` (MLB nacional):
 *   { clientId, clientSecret, redirectUri, sellerId, accessToken,
 *     refreshToken, tokenExpiresAt (ISO), siteId: 'MLB' }
 *
 * - access_token expira em 6h (expires_in=10800).
 * - refresh_token é de USO ÚNICO e rotaciona: a cada refresh o ML devolve um
 *   novo refresh_token — sempre persistimos o mais recente, senão o próximo
 *   refresh dá invalid_grant.
 */
@Injectable()
export class MercadoLivreOAuthService {
  private static readonly AUTH_URL = 'https://auth.mercadolivre.com.br/authorization';
  private static readonly TOKEN_URL = 'https://api.mercadolibre.com/oauth/token';
  private static readonly EXPIRY_BUFFER_MS = 5 * 60 * 1000; // renova 5min antes
  private readonly logger = new Logger(MercadoLivreOAuthService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** URL para redirecionar o vendedor e iniciar o consentimento. */
  buildAuthUrl(clientId: string, redirectUri: string, state: string): string {
    const q = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
    });
    return `${MercadoLivreOAuthService.AUTH_URL}?${q.toString()}`;
  }

  /** Troca o `code` do callback por tokens. Retorna o payload do ML. */
  async exchangeCode(
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ): Promise<any> {
    return this.tokenRequest({
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    });
  }

  /**
   * Retorna um access_token válido para o canal, renovando (e persistindo o
   * refresh_token rotacionado) quando está perto de expirar.
   */
  async getValidAccessToken(channel: Channel, force = false): Promise<string> {
    const cfg = (channel.config ?? {}) as Record<string, any>;
    const expMs = cfg.tokenExpiresAt ? Date.parse(cfg.tokenExpiresAt) : 0;
    const stillValid =
      !force &&
      cfg.accessToken &&
      expMs - MercadoLivreOAuthService.EXPIRY_BUFFER_MS > Date.now();
    if (stillValid) return cfg.accessToken;

    if (!cfg.refreshToken || !cfg.clientId || !cfg.clientSecret) {
      throw new Error(
        `Canal ML ${channel.id} sem refreshToken/clientId/clientSecret — reconecte o OAuth`,
      );
    }
    const data = await this.tokenRequest({
      grant_type: 'refresh_token',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      refresh_token: cfg.refreshToken,
    });
    await this.persistTokens(channel.id, cfg, data);
    return data.access_token;
  }

  /** Persiste tokens no config do canal (merge, preserva credenciais). */
  async persistTokens(
    channelId: string,
    currentConfig: Record<string, any>,
    tokenPayload: any,
  ): Promise<Record<string, any>> {
    const expiresInMs = (Number(tokenPayload.expires_in) || 10800) * 1000;
    const merged = {
      ...currentConfig,
      accessToken: tokenPayload.access_token,
      // rotação: sempre grava o refresh_token novo
      refreshToken: tokenPayload.refresh_token ?? currentConfig.refreshToken,
      tokenExpiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      sellerId: String(tokenPayload.user_id ?? currentConfig.sellerId ?? ''),
    };
    await this.prisma.channel.update({
      where: { id: channelId },
      data: { config: merged },
    });
    return merged;
  }

  private async tokenRequest(body: Record<string, string>): Promise<any> {
    try {
      const res = await axios.post(
        MercadoLivreOAuthService.TOKEN_URL,
        new URLSearchParams(body).toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          timeout: 15000,
        },
      );
      return res.data;
    } catch (error: any) {
      const detail = error.response?.data
        ? JSON.stringify(error.response.data)
        : error.message;
      this.logger.error(`ML token request (${body.grant_type}) falhou: ${detail}`);
      throw error;
    }
  }
}
