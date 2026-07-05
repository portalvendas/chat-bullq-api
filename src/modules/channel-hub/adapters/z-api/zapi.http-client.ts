import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';

/**
 * Cliente HTTP do Z-API (https://z-api.io).
 *
 * O Z-API carrega instância + token no PATH da URL e o token de segurança
 * da conta no header `Client-Token`:
 *   POST https://api.z-api.io/instances/{instanceId}/token/{token}/send-text
 *   headers: { 'Client-Token': <clientToken> }
 *
 * `channel.config` esperado: { instanceId, token, clientToken }.
 */
@Injectable()
export class ZApiHttpClient {
  private static readonly BASE_URL = 'https://api.z-api.io';
  private readonly logger = new Logger(ZApiHttpClient.name);

  private createClient(channel: Channel): AxiosInstance {
    const config = (channel.config ?? {}) as Record<string, any>;
    const { instanceId, token, clientToken } = config;
    if (!instanceId || !token) {
      throw new Error(
        `Z-API channel ${channel.id} sem config.instanceId/token`,
      );
    }
    return axios.create({
      baseURL: `${ZApiHttpClient.BASE_URL}/instances/${instanceId}/token/${token}`,
      headers: {
        'Content-Type': 'application/json',
        ...(clientToken ? { 'Client-Token': String(clientToken) } : {}),
      },
      timeout: 30000,
    });
  }

  async sendRequest(
    channel: Channel,
    endpoint: string,
    payload: Record<string, any>,
  ): Promise<any> {
    const client = this.createClient(channel);
    try {
      const response = await client.post(endpoint, payload);
      return response.data;
    } catch (error: any) {
      this.logger.error(
        `Z-API error: ${endpoint} - ${
          error.response?.data?.error ||
          error.response?.data?.message ||
          error.message
        }`,
      );
      throw error;
    }
  }

  /** Status da instância (conectada/desconectada). Usado no testConnection. */
  async getInstanceStatus(channel: Channel): Promise<any> {
    const client = this.createClient(channel);
    const response = await client.get('/status');
    return response.data;
  }

  /** Baixa mídia a partir da URL entregue no webhook (Fase 2). */
  async getMediaBuffer(_channel: Channel, mediaUrl: string): Promise<Buffer> {
    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    return Buffer.from(response.data);
  }
}
