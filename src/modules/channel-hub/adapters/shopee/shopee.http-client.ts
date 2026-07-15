import { Injectable, Logger, BadGatewayException } from '@nestjs/common';
import { Channel } from '@prisma/client';
import axios, { AxiosRequestConfig } from 'axios';
import { ShopeeOAuthService } from './shopee.oauth.service';

/**
 * Cliente HTTP autenticado do Shopee Open Platform v2. Assina cada request
 * (HMAC via oauth service), injeta partner_id/timestamp/sign + access_token/
 * shop_id nos query params. O Shopee devolve erro em `body.error` mesmo com
 * HTTP 200 — se for erro de token, força refresh e tenta 1x mais.
 */
@Injectable()
export class ShopeeHttpClient {
  private readonly logger = new Logger(ShopeeHttpClient.name);
  // Códigos de erro de token do Shopee → dispara refresh + retry.
  private static readonly TOKEN_ERRORS = new Set([
    'error_auth',
    'invalid_access_token',
    'access_token_error',
    'error_token',
  ]);

  constructor(private readonly oauth: ShopeeOAuthService) {}

  get<T = any>(channel: Channel, path: string, params?: Record<string, any>): Promise<T> {
    return this.request<T>(channel, path, { method: 'GET', params });
  }

  post<T = any>(channel: Channel, path: string, body: any): Promise<T> {
    return this.request<T>(channel, path, { method: 'POST', data: body });
  }

  private async request<T>(
    channel: Channel,
    path: string,
    config: { method: 'GET' | 'POST'; params?: Record<string, any>; data?: any },
    retriedAfterToken = false,
  ): Promise<T> {
    const { accessToken, shopId } = await this.oauth.getValidAccessToken(
      channel,
      retriedAfterToken,
    );
    const common = this.oauth.commonParams(path, { accessToken, shopId });
    const url = `${this.oauth.apiBase()}${path}`;
    const req: AxiosRequestConfig = {
      method: config.method,
      url,
      params: { ...common, ...(config.params ?? {}) },
      data: config.data,
      timeout: 20000,
      headers: { 'Content-Type': 'application/json' },
    };
    let res;
    try {
      res = await axios.request<any>(req);
    } catch (err: any) {
      const status = err?.response?.status;
      const detail = err?.response?.data
        ? JSON.stringify(err.response.data)
        : err.message;
      this.logger.error(`Shopee ${config.method} ${path} falhou (${status}): ${detail}`);
      throw new BadGatewayException(`Shopee API ${path}: ${detail}`.slice(0, 500));
    }

    // Shopee: erro vem no corpo mesmo com 200.
    const body = res.data ?? {};
    if (body.error) {
      if (
        !retriedAfterToken &&
        ShopeeHttpClient.TOKEN_ERRORS.has(String(body.error))
      ) {
        this.logger.warn(
          `Shopee ${path}: erro de token (${body.error}) — refresh + retry`,
        );
        return this.request<T>(channel, path, config, true);
      }
      this.logger.error(
        `Shopee ${path} retornou erro: ${body.error} ${body.message ?? ''}`,
      );
      throw new BadGatewayException(
        `Shopee ${path}: ${body.error} ${body.message ?? ''}`.slice(0, 500),
      );
    }
    return body as T;
  }
}
