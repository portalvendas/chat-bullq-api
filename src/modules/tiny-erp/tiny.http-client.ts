import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../database/prisma.service';
import axios, { AxiosInstance } from 'axios';

/**
 * Cliente do ERP Olist Tiny (API pública v3), portado do `olist_client.py` do
 * Precificador. Responsabilidades:
 *  - OAuth 2.0 (Authorization Code): URL de autorização, troca de `code` por
 *    tokens, refresh automático quando o access_token está por expirar.
 *  - Chamada genérica autenticada com refresh-on-401 e retry em 429/5xx.
 *  - Endpoints usados pela integração: listar pedidos (incremental), listar
 *    orçamentos (propostas) e obter contato (pra resolver cliente do orçamento).
 *
 * Segredos (client_id/secret) vêm SEMPRE de env — nunca hardcoded.
 * Doc: https://api-docs.erp.olist.com
 */
@Injectable()
export class TinyHttpClient {
  private readonly logger = new Logger(TinyHttpClient.name);

  // Endpoints do realm Keycloak do Tiny (mesmos do Precificador).
  private static readonly AUTH_URL =
    'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/auth';
  private static readonly TOKEN_URL =
    'https://accounts.tiny.com.br/realms/tiny/protocol/openid-connect/token';

  private readonly apiBase: string;
  private readonly client: AxiosInstance;

  // Throttle proativo: o Tiny limita ~120 req/min POR CONTA (compartilhado
  // entre apps). Serializamos as chamadas com um intervalo mínimo pra não
  // estourar. `nextAllowedAt` é o instante em que a próxima request pode sair.
  private static readonly MIN_INTERVAL_MS = 650; // ~92 req/min, folga de segurança
  private nextAllowedAt = 0;

  private async throttle(): Promise<void> {
    const now = Date.now();
    const wait = this.nextAllowedAt - now;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.nextAllowedAt =
      Math.max(now, this.nextAllowedAt) + TinyHttpClient.MIN_INTERVAL_MS;
  }

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.apiBase =
      this.config.get<string>('TINY_API_BASE') ||
      'https://api.tiny.com.br/public-api/v3';
    this.client = axios.create({ timeout: 30_000 });
  }

  private creds(): { clientId: string; clientSecret: string; redirectUri: string } {
    // Aceita tanto TINY_* (novo) quanto OLIST_* (reaproveita o app já criado
    // no Precificador) — o app da Meta/Tiny é o mesmo, só muda a redirect URI.
    const clientId =
      this.config.get<string>('TINY_CLIENT_ID') ||
      this.config.get<string>('OLIST_CLIENT_ID') ||
      '';
    const clientSecret =
      this.config.get<string>('TINY_CLIENT_SECRET') ||
      this.config.get<string>('OLIST_CLIENT_SECRET') ||
      '';
    const redirectUri =
      this.config.get<string>('TINY_REDIRECT_URI') ||
      `${(this.config.get<string>('APP_URL') || '').replace(/\/$/, '')}/api/v1/tiny/oauth/callback`;
    return { clientId, clientSecret, redirectUri };
  }

  /** URL de consentimento OAuth. `state` carrega o organizationId (assinado no service). */
  buildAuthorizeUrl(state: string): string {
    const { clientId, redirectUri } = this.creds();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: 'openid',
      state,
    });
    return `${TinyHttpClient.AUTH_URL}?${params.toString()}`;
  }

  private basicAuth(): string {
    const { clientId, clientSecret } = this.creds();
    return Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  }

  /** Troca o `code` do callback por access_token + refresh_token. */
  async exchangeCode(code: string): Promise<TinyTokenResponse> {
    const { redirectUri } = this.creds();
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });
    const { data } = await this.client.post(TinyHttpClient.TOKEN_URL, body, {
      headers: {
        Authorization: `Basic ${this.basicAuth()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    return data as TinyTokenResponse;
  }

  /** Renova o access_token a partir do refresh_token. */
  async refresh(refreshToken: string): Promise<TinyTokenResponse> {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    const { data } = await this.client.post(TinyHttpClient.TOKEN_URL, body, {
      headers: {
        Authorization: `Basic ${this.basicAuth()}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });
    return data as TinyTokenResponse;
  }

  /**
   * Garante um access_token válido para a org: refresha quando faltam <60s.
   * Persiste os novos tokens na TinyIntegration. Lança se não houver conexão
   * ativa / refresh_token.
   */
  private async ensureAccessToken(organizationId: string): Promise<string> {
    const integ = await this.prisma.tinyIntegration.findUnique({
      where: { organizationId },
    });
    if (!integ || integ.status === 'revoked' || !integ.accessToken) {
      throw new TinyApiError(401, 'Integração Tiny não conectada');
    }
    const soonMs = 60_000;
    const expired =
      !integ.tokenExpiresAt ||
      integ.tokenExpiresAt.getTime() - Date.now() < soonMs;
    if (!expired) return integ.accessToken;

    if (!integ.refreshToken) {
      throw new TinyApiError(401, 'Integração Tiny sem refresh_token');
    }
    const data = await this.refresh(integ.refreshToken);
    const updated = await this.persistTokens(organizationId, data);
    return updated.accessToken!;
  }

  /** Persiste tokens (usado no callback e no refresh). Marca a integração ativa. */
  async persistTokens(organizationId: string, data: TinyTokenResponse) {
    const now = Date.now();
    const expiresAt = data.expires_in
      ? new Date(now + Number(data.expires_in) * 1000)
      : null;
    const refreshExpiresAt = data.refresh_expires_in
      ? new Date(now + Number(data.refresh_expires_in) * 1000)
      : null;
    return this.prisma.tinyIntegration.update({
      where: { organizationId },
      data: {
        status: 'active',
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        tokenExpiresAt: expiresAt,
        refreshExpiresAt: refreshExpiresAt,
        lastError: null,
      },
    });
  }

  /**
   * Chamada GET autenticada à API v3, escopada a uma org. Refresha e re-tenta
   * 1x em 401; faz backoff simples em 429/5xx (até 3 tentativas). Retorna o
   * corpo JSON já parseado.
   */
  async get<T = any>(
    organizationId: string,
    path: string,
    params?: Record<string, any>,
  ): Promise<T> {
    let token = await this.ensureAccessToken(organizationId);
    const url = `${this.apiBase}/${path.replace(/^\//, '')}`;

    const maxAttempts = 5;
    let lastErr: any;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.throttle();
        const { data } = await this.client.get(url, {
          params,
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        });
        return data as T;
      } catch (err: any) {
        lastErr = err;
        const status = err?.response?.status;
        if (status === 401 && attempt === 1) {
          // Token pode ter expirado no meio — força refresh e re-tenta.
          const integ = await this.prisma.tinyIntegration.findUnique({
            where: { organizationId },
          });
          if (integ?.refreshToken) {
            const data = await this.refresh(integ.refreshToken);
            const up = await this.persistTokens(organizationId, data);
            token = up.accessToken!;
            continue;
          }
        }
        if (status === 429 && attempt < maxAttempts) {
          // Respeita o header de reset (segundos) quando presente; segura TODAS
          // as próximas requests até o limite liberar.
          const h = err?.response?.headers ?? {};
          const resetS = Number(h['x-ratelimit-reset'] ?? h['retry-after'] ?? 3);
          const waitMs = (Number.isFinite(resetS) ? Math.min(resetS, 65) : 3) * 1000 + 1000;
          this.nextAllowedAt = Date.now() + waitMs;
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        if (status >= 500 && status <= 599 && attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 500 * attempt));
          continue;
        }
        throw new TinyApiError(
          status ?? 0,
          err?.response?.data?.mensagem || err?.message || 'Tiny API error',
          err?.response?.data,
        );
      }
    }
    throw new TinyApiError(0, lastErr?.message || 'Tiny API error');
  }

  // ── Endpoints usados pela integração ────────────────────────────────

  /**
   * Lista pedidos. `dataAtualizacao` (YYYY-MM-DD) habilita o sync incremental
   * (só o que mudou a partir da data). A listagem já traz o cliente inline
   * (nome, cpfCnpj, telefone/celular, email) — suficiente pro match.
   */
  listarPedidos(
    organizationId: string,
    params: { offset?: number; limit?: number; dataAtualizacao?: string },
  ): Promise<TinyPaginated<any>> {
    return this.get(organizationId, 'pedidos', {
      offset: params.offset ?? 0,
      limit: params.limit ?? 100,
      ...(params.dataAtualizacao ? { dataAtualizacao: params.dataAtualizacao } : {}),
      orderBy: 'desc',
    });
  }

  /**
   * Lista orçamentos (propostas comerciais). Não há filtro por dataAtualizacao;
   * usamos dataInicio/dataFim (data de criação). O item traz só `contato.id` —
   * o cliente completo vem por getContato.
   */
  listarOrcamentos(
    organizationId: string,
    params: { offset?: number; limit?: number; dataInicio?: string; dataFim?: string },
  ): Promise<TinyPaginated<any>> {
    return this.get(organizationId, 'orcamentos', {
      offset: params.offset ?? 0,
      limit: params.limit ?? 100,
      ...(params.dataInicio ? { dataInicio: params.dataInicio } : {}),
      ...(params.dataFim ? { dataFim: params.dataFim } : {}),
    });
  }

  /** Detalhe de um contato do Tiny — pra resolver cliente do orçamento. */
  getContato(organizationId: string, contatoId: string | number): Promise<any> {
    return this.get(organizationId, `contatos/${contatoId}`);
  }

  /** Detalhe de um pedido — inclui os `itens` (a listagem não traz). */
  getPedido(organizationId: string, pedidoId: string | number): Promise<any> {
    return this.get(organizationId, `pedidos/${pedidoId}`);
  }

  /** Detalhe de um orçamento (proposta) — inclui os `itens`. */
  getOrcamento(organizationId: string, orcamentoId: string | number): Promise<any> {
    return this.get(organizationId, `orcamentos/${orcamentoId}`);
  }

  /** Dados da conta conectada (best-effort, pra rotular a integração). */
  async getContaEmpresa(organizationId: string): Promise<any | null> {
    try {
      return await this.get(organizationId, 'info');
    } catch {
      return null;
    }
  }
}

export interface TinyTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in?: number;
  refresh_expires_in?: number;
  token_type?: string;
}

export interface TinyPaginated<T> {
  itens?: T[];
  paginacao?: { limit: number; offset: number; total: number };
}

export class TinyApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly payload?: unknown,
  ) {
    super(message);
    this.name = 'TinyApiError';
  }
}
