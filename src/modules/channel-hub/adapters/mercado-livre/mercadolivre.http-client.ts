import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import axios, { AxiosRequestConfig } from 'axios';
import { MercadoLivreOAuthService } from './mercadolivre.oauth.service';

/**
 * Cliente HTTP autenticado do Mercado Livre.
 * Base: https://api.mercadolibre.com — Bearer via OAuth service.
 * Em 401 (token revogado antes de expirar), força um refresh e tenta 1x mais.
 */
@Injectable()
export class MercadoLivreHttpClient {
  private static readonly BASE_URL = 'https://api.mercadolibre.com';
  private readonly logger = new Logger(MercadoLivreHttpClient.name);

  constructor(private readonly oauth: MercadoLivreOAuthService) {}

  async get<T = any>(channel: Channel, path: string): Promise<T> {
    return this.request<T>(channel, { method: 'GET', url: path });
  }

  async post<T = any>(channel: Channel, path: string, body: any): Promise<T> {
    return this.request<T>(channel, { method: 'POST', url: path, data: body });
  }

  private async request<T>(
    channel: Channel,
    config: AxiosRequestConfig,
    retriedAfter401 = false,
  ): Promise<T> {
    const token = await this.oauth.getValidAccessToken(channel, retriedAfter401);
    try {
      const res = await axios.request<T>({
        baseURL: MercadoLivreHttpClient.BASE_URL,
        ...config,
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          accept: 'application/json',
          ...(config.headers ?? {}),
        },
        timeout: 20000,
      });
      return res.data;
    } catch (error: any) {
      const st = error.response?.status;
      if (st === 401 && !retriedAfter401) {
        this.logger.warn(`ML 401 em ${config.url} — forçando refresh e retry`);
        return this.request<T>(channel, config, true);
      }
      const detail = error.response?.data
        ? JSON.stringify(error.response.data)
        : error.message;
      this.logger.error(`ML API ${config.method} ${config.url} falhou (${st}): ${detail}`);
      throw error;
    }
  }
}
