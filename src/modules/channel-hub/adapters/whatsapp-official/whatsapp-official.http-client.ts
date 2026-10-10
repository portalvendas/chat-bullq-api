import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';
// CommonJS import: `import FormData from 'form-data'` compila mas quebra em
// runtime ("form_data_1.default is not a constructor"), pois o pacote é CJS
// (module.exports = FormData, sem .default). import = require resolve isso.
import FormData = require('form-data');

interface WaOfficialConfig {
  accessToken: string;
  phoneNumberId: string;
  businessAccountId?: string;
  apiVersion?: string;
}

@Injectable()
export class WhatsAppOfficialHttpClient {
  private readonly logger = new Logger(WhatsAppOfficialHttpClient.name);

  private getConfig(channel: Channel): WaOfficialConfig {
    const config = channel.config as Record<string, any>;
    return {
      accessToken: config.accessToken,
      phoneNumberId: config.phoneNumberId,
      businessAccountId: config.businessAccountId,
      apiVersion: config.apiVersion || 'v21.0',
    };
  }

  private createClient(channel: Channel): AxiosInstance {
    const cfg = this.getConfig(channel);
    return axios.create({
      baseURL: `https://graph.facebook.com/${cfg.apiVersion}`,
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
      timeout: 30000,
    });
  }

  async sendMessage(
    channel: Channel,
    payload: Record<string, any>,
  ): Promise<any> {
    const cfg = this.getConfig(channel);
    const client = this.createClient(channel);
    try {
      const { data } = await client.post(
        `/${cfg.phoneNumberId}/messages`,
        payload,
      );
      return data;
    } catch (error: any) {
      this.logger.error(
        `WA Official API error: ${error.response?.data?.error?.message || error.message}`,
      );
      throw error;
    }
  }

  /**
   * Faz upload do arquivo de mídia para a Cloud API (`POST /{phoneNumberId}/media`)
   * e retorna o `media id`. Enviar mídia por ID é durável: a Meta guarda a
   * própria cópia, diferente do `link` (que depende da nossa URL pública
   * continuar acessível e não ser purgada pela retenção — causa do áudio que
   * o destinatário via como "não está mais disponível").
   */
  async uploadMedia(
    channel: Channel,
    file: { buffer: Buffer; mimeType: string; filename: string },
  ): Promise<string> {
    const cfg = this.getConfig(channel);
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', file.mimeType);
    form.append('file', file.buffer, {
      filename: file.filename,
      contentType: file.mimeType,
    });
    try {
      const { data } = await axios.post(
        `https://graph.facebook.com/${cfg.apiVersion}/${cfg.phoneNumberId}/media`,
        form,
        {
          headers: {
            Authorization: `Bearer ${cfg.accessToken}`,
            ...form.getHeaders(),
          },
          timeout: 60000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        },
      );
      if (!data?.id) {
        throw new Error('Upload de mídia não retornou id');
      }
      return data.id as string;
    } catch (error: any) {
      this.logger.error(
        `WA Official media upload error: ${error.response?.data?.error?.message || error.message}`,
      );
      throw error;
    }
  }

  async getMediaUrl(channel: Channel, mediaId: string): Promise<string> {
    const client = this.createClient(channel);
    const { data } = await client.get(`/${mediaId}`);
    return data.url;
  }

  async downloadMedia(channel: Channel, url: string): Promise<Buffer> {
    const cfg = this.getConfig(channel);
    const response = await axios.get(url, {
      headers: { Authorization: `Bearer ${cfg.accessToken}` },
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    return Buffer.from(response.data);
  }

  async verifyPhoneNumber(channel: Channel): Promise<any> {
    const cfg = this.getConfig(channel);
    const client = this.createClient(channel);
    try {
      const { data } = await client.get(`/${cfg.phoneNumberId}`);
      return data;
    } catch (error: any) {
      this.logger.error(`WA Official verify failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * Subscribes our app to receive webhooks for this WABA. Idempotent on
   * Meta's side — re-calling is safe. Requires `whatsapp_business_management`
   * scope on the access token.
   */
  async subscribeApp(channel: Channel): Promise<any> {
    const cfg = this.getConfig(channel);
    if (!cfg.businessAccountId) {
      throw new Error('businessAccountId required to subscribe app');
    }
    const client = this.createClient(channel);
    const { data } = await client.post(`/${cfg.businessAccountId}/subscribed_apps`);
    return data;
  }
}
