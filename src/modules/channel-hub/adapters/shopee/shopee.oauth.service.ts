import { Injectable, Logger, BadGatewayException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Channel } from '@prisma/client';
import axios from 'axios';
import * as crypto from 'crypto';
import { PrismaService } from '../../../../database/prisma.service';

/**
 * Auth do Shopee Open Platform API v2. Portado do `shopee_client.py` do
 * projeto Precificador. Cada request é assinado com HMAC-SHA256:
 *   base pública/auth = partner_id + path + timestamp
 *   base de loja      = partner_id + path + timestamp + access_token + shop_id
 *   sign = HMAC_SHA256(partner_key, base).hex  → query param
 *
 * Credenciais (app compartilhada com o Precificador) via env:
 *   SHOPEE_PARTNER_ID, SHOPEE_PARTNER_KEY, SHOPEE_API_BASE
 * `shop_id` + tokens ficam em `channel.config`.
 */
@Injectable()
export class ShopeeOAuthService {
  private readonly logger = new Logger(ShopeeOAuthService.name);
  private static readonly EXPIRY_BUFFER_MS = 5 * 60 * 1000; // renova 5min antes

  static readonly PATH_TOKEN_GET = '/api/v2/auth/token/get';
  static readonly PATH_TOKEN_REFRESH = '/api/v2/auth/access_token/get';
  static readonly PATH_AUTH_PARTNER = '/api/v2/shop/auth_partner';
  private static readonly PUBLIC_PATHS = new Set([
    ShopeeOAuthService.PATH_TOKEN_GET,
    ShopeeOAuthService.PATH_TOKEN_REFRESH,
    ShopeeOAuthService.PATH_AUTH_PARTNER,
  ]);

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  /** Remove espaços e aspas acidentais coladas no valor da env. */
  private clean(v: string | undefined | null): string {
    return (v ?? '').trim().replace(/^["']+|["']+$/g, '').trim();
  }

  private creds(): { partnerId: number; partnerKey: string } {
    // strip + remove aspas acidentais: espaço/aspas/newline na partner_key é a
    // causa clássica de "Wrong sign" (a HMAC muda com qualquer byte extra).
    const partnerId = Number(this.clean(this.config.get<string>('SHOPEE_PARTNER_ID')));
    const partnerKey = this.clean(this.config.get<string>('SHOPEE_PARTNER_KEY'));
    if (!partnerId || !partnerKey) {
      throw new BadGatewayException(
        'Shopee não configurado: defina SHOPEE_PARTNER_ID e SHOPEE_PARTNER_KEY no ambiente.',
      );
    }
    return { partnerId, partnerKey };
  }

  apiBase(): string {
    const b = (this.config.get<string>('SHOPEE_API_BASE') || '').trim().replace(/\/$/, '');
    return b && b.includes('shopeemobile.com')
      ? b
      : 'https://partner.shopeemobile.com';
  }

  /** HMAC-SHA256 hex da base (pública vs loja). */
  sign(
    path: string,
    timestamp: number,
    opts: { accessToken?: string; shopId?: string | number } = {},
  ): string {
    const { partnerId, partnerKey } = this.creds();
    let base = `${partnerId}${path}${timestamp}`;
    if (!ShopeeOAuthService.PUBLIC_PATHS.has(path)) {
      base += `${opts.accessToken ?? ''}${opts.shopId ?? ''}`;
    }
    return crypto.createHmac('sha256', partnerKey).update(base).digest('hex');
  }

  /** Query params comuns (partner_id, timestamp, sign [+ access_token, shop_id]). */
  commonParams(
    path: string,
    opts: { accessToken?: string; shopId?: string | number } = {},
  ): Record<string, string> {
    const { partnerId } = this.creds();
    const ts = Math.floor(Date.now() / 1000);
    const params: Record<string, string> = {
      partner_id: String(partnerId),
      timestamp: String(ts),
      sign: this.sign(path, ts, opts),
    };
    if (!ShopeeOAuthService.PUBLIC_PATHS.has(path)) {
      if (opts.accessToken) params.access_token = opts.accessToken;
      if (opts.shopId != null) params.shop_id = String(opts.shopId);
    }
    return params;
  }

  /** URL de autorização da loja. Shopee redireciona pra redirectUri?code=&shop_id=. */
  buildAuthUrl(redirectUri: string): string {
    const params = this.commonParams(ShopeeOAuthService.PATH_AUTH_PARTNER);
    params.redirect = redirectUri;
    return `${this.apiBase()}${ShopeeOAuthService.PATH_AUTH_PARTNER}?${new URLSearchParams(
      params,
    ).toString()}`;
  }

  /** Troca o `code` do redirect por tokens e guarda shop_id no canal. */
  async exchangeCode(
    channel: Channel,
    code: string,
    shopId: string | number,
  ): Promise<void> {
    const { partnerId } = this.creds();
    const params = this.commonParams(ShopeeOAuthService.PATH_TOKEN_GET);
    const url = `${this.apiBase()}${ShopeeOAuthService.PATH_TOKEN_GET}?${new URLSearchParams(
      params,
    ).toString()}`;
    let data: any;
    try {
      const res = await axios.post(
        url,
        { code, shop_id: Number(shopId), partner_id: partnerId },
        { timeout: 20000 },
      );
      data = res.data;
    } catch (err: any) {
      throw new BadGatewayException(
        `Shopee: falha ao trocar code por token: ${err?.response?.data ? JSON.stringify(err.response.data) : err.message}`,
      );
    }
    if (!data?.access_token || data?.error) {
      throw new BadGatewayException(
        `Shopee: resposta de token inválida: ${JSON.stringify(data).slice(0, 300)}`,
      );
    }
    const cfg = (channel.config ?? {}) as Record<string, any>;
    await this.persistTokens(channel.id, { ...cfg, shopId: String(shopId) }, data);
  }

  /** Retorna { accessToken, shopId } válidos — refresh se faltar < 5min. */
  async getValidAccessToken(
    channel: Channel,
    force = false,
  ): Promise<{ accessToken: string; shopId: string }> {
    const cfg = (channel.config ?? {}) as Record<string, any>;
    const shopId = String(cfg.shopId ?? '');
    if (!shopId) {
      throw new BadGatewayException(
        'Canal Shopee não conectado (sem shop_id — refazer OAuth).',
      );
    }
    const expMs = cfg.tokenExpiresAt ? new Date(cfg.tokenExpiresAt).getTime() : 0;
    const valid =
      !force &&
      cfg.accessToken &&
      expMs - ShopeeOAuthService.EXPIRY_BUFFER_MS > Date.now();
    if (valid) return { accessToken: cfg.accessToken, shopId };
    return this.refresh(channel);
  }

  private async refresh(
    channel: Channel,
  ): Promise<{ accessToken: string; shopId: string }> {
    const { partnerId } = this.creds();
    const cfg = (channel.config ?? {}) as Record<string, any>;
    const shopId = String(cfg.shopId ?? '');
    if (!cfg.refreshToken || !shopId) {
      throw new BadGatewayException(
        'Canal Shopee sem refresh_token/shop_id — refazer OAuth.',
      );
    }
    const params = this.commonParams(ShopeeOAuthService.PATH_TOKEN_REFRESH);
    const url = `${this.apiBase()}${ShopeeOAuthService.PATH_TOKEN_REFRESH}?${new URLSearchParams(
      params,
    ).toString()}`;
    let data: any;
    try {
      const res = await axios.post(
        url,
        {
          refresh_token: cfg.refreshToken,
          shop_id: Number(shopId),
          partner_id: partnerId,
        },
        { timeout: 20000 },
      );
      data = res.data;
    } catch (err: any) {
      throw new BadGatewayException(
        `Shopee: falha no refresh: ${err?.response?.data ? JSON.stringify(err.response.data) : err.message}`,
      );
    }
    if (!data?.access_token || data?.error) {
      throw new BadGatewayException(
        `Shopee: refresh inválido: ${JSON.stringify(data).slice(0, 300)}`,
      );
    }
    await this.persistTokens(channel.id, cfg, data);
    return { accessToken: data.access_token, shopId };
  }

  private async persistTokens(
    channelId: string,
    cfg: Record<string, any>,
    data: any,
  ): Promise<void> {
    const expiresInS = Number(data.expire_in ?? data.expires_in ?? 0);
    const newCfg = {
      ...cfg,
      accessToken: data.access_token,
      // refresh_token do Shopee rotaciona em cada refresh — sempre atualiza.
      refreshToken: data.refresh_token ?? cfg.refreshToken,
      tokenExpiresAt: new Date(Date.now() + expiresInS * 1000).toISOString(),
    };
    await this.prisma.channel.update({
      where: { id: channelId },
      data: { config: newCfg },
    });
  }
}
