import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Channel, ChannelType } from '@prisma/client';
import axios from 'axios';
import { PrismaService } from '../../../../database/prisma.service';

/**
 * OAuth2 do Instagram (Instagram API with Instagram Login).
 *
 * Mesmo modelo do Mercado Livre/Shopee: app compartilhada, secret SÓ no
 * ambiente (nunca no front), state = channelId. Fluxo:
 *  1. buildAuthUrl        -> usuário autoriza em instagram.com
 *  2. exchangeCode        -> code -> token CURTO (1h) + user_id
 *  3. exchangeForLongLived-> token curto -> token LONGO (~60 dias)
 *  4. persistTokens       -> grava em channel.config no formato que o
 *     InstagramHttpClient + inbound-adapter já consomem
 *  5. getValidAccessToken / refreshExpiringSoon -> renova (ig_refresh_token)
 *
 * Env (nunca hardcoded):
 *  - INSTAGRAM_APP_ID     (client_id do produto Instagram do app Meta)
 *  - INSTAGRAM_APP_SECRET (client_secret; também vira o appSecret do canal,
 *    usado pra validar x-hub-signature-256 dos webhooks)
 */
@Injectable()
export class InstagramOAuthService {
  private static readonly AUTHORIZE_URL =
    'https://www.instagram.com/oauth/authorize';
  private static readonly TOKEN_URL =
    'https://api.instagram.com/oauth/access_token';
  private static readonly GRAPH_URL = 'https://graph.instagram.com';
  private static readonly DEFAULT_SCOPE =
    'instagram_business_basic,instagram_business_manage_messages,instagram_business_manage_comments';
  // token longo dura ~60 dias; renova quando faltar <= 5 dias.
  private static readonly REFRESH_BUFFER_MS = 5 * 24 * 60 * 60 * 1000;
  private static readonly DEFAULT_TTL_S = 60 * 24 * 60 * 60;

  private readonly logger = new Logger(InstagramOAuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  private appId(): string {
    const id = this.config.get<string>('INSTAGRAM_APP_ID');
    if (!id) throw new Error('INSTAGRAM_APP_ID não configurado no ambiente');
    return id;
  }

  private appSecret(): string {
    const s = this.config.get<string>('INSTAGRAM_APP_SECRET');
    if (!s) throw new Error('INSTAGRAM_APP_SECRET não configurado no ambiente');
    return s;
  }

  /** URL de consentimento. `state` = channelId (validado no callback). */
  buildAuthUrl(redirectUri: string, state: string, scope?: string): string {
    const q = new URLSearchParams({
      client_id: this.appId(),
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: scope || InstagramOAuthService.DEFAULT_SCOPE,
      state,
    });
    return `${InstagramOAuthService.AUTHORIZE_URL}?${q.toString()}`;
  }

  /** Troca o `code` por token CURTO (form-encoded). */
  async exchangeCode(
    code: string,
    redirectUri: string,
  ): Promise<{ access_token: string; user_id: string }> {
    try {
      const body = new URLSearchParams({
        client_id: this.appId(),
        client_secret: this.appSecret(),
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
        code,
      });
      const res = await axios.post(
        InstagramOAuthService.TOKEN_URL,
        body.toString(),
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            accept: 'application/json',
          },
          timeout: 15000,
        },
      );
      // pode vir { access_token, user_id } ou { data: [ {...} ] }
      const d = Array.isArray(res.data?.data) ? res.data.data[0] : res.data;
      this.logger.log(
        `exchangeCode ok: user_id=${d?.user_id} token=${this.preview(d?.access_token)}`,
      );
      return { access_token: d.access_token, user_id: String(d.user_id) };
    } catch (err: any) {
      throw this.logAndRethrow('exchangeCode', err);
    }
  }

  /** Troca o token CURTO por LONGO (~60 dias). */
  async exchangeForLongLived(
    shortToken: string,
  ): Promise<{ access_token: string; expires_in: number }> {
    const url = `${InstagramOAuthService.GRAPH_URL}/access_token`;
    const params = {
      grant_type: 'ig_exchange_token',
      client_secret: this.appSecret(),
      access_token: shortToken,
    };
    this.logger.log(
      `exchangeForLongLived → GET ${url} (token=${this.preview(shortToken)}, secret=${this.preview(this.appSecret())})`,
    );
    try {
      const res = await axios.get(url, {
        params,
        headers: { accept: 'application/json' },
        timeout: 15000,
      });
      return {
        access_token: res.data.access_token,
        expires_in:
          Number(res.data.expires_in) || InstagramOAuthService.DEFAULT_TTL_S,
      };
    } catch (err: any) {
      const code = err?.response?.data?.error?.code;
      // Alguns setups da Meta respondem code 100 ("method type: get") ao GET
      // deste endpoint. Fallback determinístico: repete como POST form-encoded.
      if (code === 100) {
        this.logger.warn(
          'exchangeForLongLived: GET devolveu code 100 — tentando POST form-encoded',
        );
        try {
          const body = new URLSearchParams(
            params as Record<string, string>,
          ).toString();
          const res2 = await axios.post(url, body, {
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              accept: 'application/json',
            },
            timeout: 15000,
          });
          this.logger.log('exchangeForLongLived: POST fallback funcionou');
          return {
            access_token: res2.data.access_token,
            expires_in:
              Number(res2.data.expires_in) ||
              InstagramOAuthService.DEFAULT_TTL_S,
          };
        } catch (err2: any) {
          throw this.logAndRethrow('exchangeForLongLived(POST)', err2);
        }
      }
      throw this.logAndRethrow('exchangeForLongLived', err);
    }
  }

  /** Renova o token LONGO (ig_refresh_token). */
  async refreshLongLived(
    longToken: string,
  ): Promise<{ access_token: string; expires_in: number }> {
    try {
      const res = await axios.get(
        `${InstagramOAuthService.GRAPH_URL}/refresh_access_token`,
        {
          params: { grant_type: 'ig_refresh_token', access_token: longToken },
          timeout: 15000,
        },
      );
      return {
        access_token: res.data.access_token,
        expires_in:
          Number(res.data.expires_in) || InstagramOAuthService.DEFAULT_TTL_S,
      };
    } catch (err: any) {
      throw this.logAndRethrow('refreshLongLived', err);
    }
  }

  /**
   * Persiste no channel.config no formato consumido pelo InstagramHttpClient +
   * inbound-adapter (assinatura de webhook e roteamento por igBusinessId).
   */
  async persistTokens(
    channelId: string,
    currentConfig: Record<string, any>,
    input: { accessToken: string; userId?: string; expiresIn: number },
  ): Promise<Record<string, any>> {
    const merged = {
      ...currentConfig,
      accessToken: input.accessToken,
      igBusinessId: input.userId
        ? String(input.userId)
        : currentConfig.igBusinessId,
      appSecret: this.appSecret(),
      apiVersion: currentConfig.apiVersion || 'v21.0',
      tokenExpiresAt: new Date(
        Date.now() + (Number(input.expiresIn) || 0) * 1000,
      ).toISOString(),
    };
    await this.prisma.channel.update({
      where: { id: channelId },
      data: { config: merged },
    });
    return merged;
  }

  /** Token válido pro canal, renovando quando perto de expirar (on-demand). */
  async getValidAccessToken(channel: Channel, force = false): Promise<string> {
    const cfg = (channel.config ?? {}) as Record<string, any>;
    const expMs = cfg.tokenExpiresAt ? Date.parse(cfg.tokenExpiresAt) : 0;
    const stillValid =
      !force &&
      cfg.accessToken &&
      expMs - InstagramOAuthService.REFRESH_BUFFER_MS > Date.now();
    if (stillValid) return cfg.accessToken;
    if (!cfg.accessToken) {
      throw new Error(
        `Canal Instagram ${channel.id} sem accessToken — reconecte o OAuth`,
      );
    }
    const data = await this.refreshLongLived(cfg.accessToken);
    const merged = await this.persistTokens(channel.id, cfg, {
      accessToken: data.access_token,
      expiresIn: data.expires_in,
    });
    return merged.accessToken;
  }

  /**
   * Rotina proativa: renova todos os canais Instagram cujo token expira dentro
   * do buffer. NUNCA lança — cada canal é isolado; erro vira log (token
   * revogado/expirado exige reconexão manual).
   */
  async refreshExpiringSoon(): Promise<{ checked: number; refreshed: number }> {
    const channels = await this.prisma.channel.findMany({
      where: { type: ChannelType.INSTAGRAM, isActive: true },
      select: { id: true, config: true },
    });
    let refreshed = 0;
    const threshold = Date.now() + InstagramOAuthService.REFRESH_BUFFER_MS;
    for (const ch of channels) {
      const cfg = (ch.config ?? {}) as Record<string, any>;
      if (!cfg.accessToken) continue;
      const expMs = cfg.tokenExpiresAt ? Date.parse(cfg.tokenExpiresAt) : 0;
      if (expMs && expMs > threshold) continue; // ainda longe de expirar
      try {
        const data = await this.refreshLongLived(cfg.accessToken);
        await this.persistTokens(ch.id, cfg, {
          accessToken: data.access_token,
          expiresIn: data.expires_in,
        });
        refreshed++;
        this.logger.log(`Token Instagram renovado: canal ${ch.id}`);
      } catch (err: any) {
        this.logger.error(
          `Falha ao renovar token Instagram canal ${ch.id}: ${err?.message ?? err} — pode exigir reconexão`,
        );
      }
    }
    return { checked: channels.length, refreshed };
  }

  private logAndRethrow(op: string, err: any): Error {
    const status = err?.response?.status;
    const cfg = err?.config ?? {};
    const method =
      typeof cfg.method === 'string' ? cfg.method.toUpperCase() : '?';
    const detail = err?.response?.data
      ? JSON.stringify(err.response.data)
      : err?.message;
    this.logger.error(
      `Instagram OAuth ${op} falhou [${method} ${cfg.url ?? '?'} status=${status ?? '?'}]: ${detail}`,
    );
    return err instanceof Error ? err : new Error(String(err));
  }

  /** Prévia redigida de um segredo/token p/ log (nunca expõe o valor inteiro). */
  private preview(s?: string): string {
    if (!s) return '<vazio>';
    if (s.length <= 8) return `len=${s.length}`;
    return `${s.slice(0, 4)}…${s.slice(-4)} len=${s.length}`;
  }
}
