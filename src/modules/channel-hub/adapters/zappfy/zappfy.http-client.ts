import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';

@Injectable()
export class ZappfyHttpClient {
  private static readonly BASE_URL = 'https://api.zappfy.io';
  private readonly logger = new Logger(ZappfyHttpClient.name);

  private createClient(channel: Channel): AxiosInstance {
    const config = channel.config as Record<string, any>;
    return axios.create({
      baseURL: ZappfyHttpClient.BASE_URL,
      headers: { token: config.token },
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
        `Zappfy API error: ${endpoint} - ${error.response?.data?.message || error.message}`,
      );
      throw error;
    }
  }

  async getInstanceStatus(channel: Channel): Promise<any> {
    const client = this.createClient(channel);
    try {
      const response = await client.get('/instance/status');
      return response.data;
    } catch (error: any) {
      this.logger.error(`Zappfy status check failed: ${error.message}`);
      throw error;
    }
  }

  /**
   * QR + status de conexão da instância Uazapi (pareamento dentro do CRM).
   *
   * Uazapi entrega `qrcode` no /instance/status quando NÃO conectada; se não
   * vier, dispara `POST /instance/connect` pra (re)gerar. Retorno normalizado:
   * `{ connected, qrcode }` — qrcode é data-URI (ou base64 cru) pronto pra img.
   */
  async getInstanceQr(
    channel: Channel,
  ): Promise<{ connected: boolean; qrcode: string | null; raw: any }> {
    const client = this.createClient(channel);
    let statusData: any = null;
    try {
      statusData = (await client.get('/instance/status')).data;
    } catch (err: any) {
      this.logger.warn(`Uazapi status (qr) falhou: ${err.message}`);
    }
    const connected = uazapiConnected(statusData);
    if (connected) return { connected: true, qrcode: null, raw: statusData };

    let qr = extractUazapiQr(statusData);
    if (!qr) {
      try {
        const conn = (await client.post('/instance/connect', {})).data;
        qr = extractUazapiQr(conn) ?? qr;
        statusData = conn ?? statusData;
      } catch (err: any) {
        this.logger.warn(`Uazapi connect (qr) falhou: ${err.message}`);
      }
    }
    return { connected, qrcode: qr, raw: statusData };
  }

  async fetchChats(
    channel: Channel,
    options: { limit?: number; offset?: number; isGroup?: boolean } = {},
  ): Promise<any> {
    return this.sendRequest(channel, '/chat/find', {
      sort: '-wa_lastMsgTimestamp',
      limit: options.limit ?? 50,
      offset: options.offset ?? 0,
      ...(options.isGroup !== undefined && { wa_isGroup: options.isGroup }),
    });
  }

  async fetchMessages(
    channel: Channel,
    chatId: string,
    limit = 50,
    offset = 0,
  ): Promise<any> {
    return this.sendRequest(channel, '/message/find', {
      chatid: chatId,
      limit,
      offset,
    });
  }

  async configureWebhook(
    channel: Channel,
    url: string,
    events = ['messages', 'messages_update'],
  ): Promise<any> {
    return this.sendRequest(channel, '/webhook', {
      enabled: true,
      url,
      events,
    });
  }

  async getMediaBuffer(
    channel: Channel,
    mediaUrl: string,
  ): Promise<Buffer> {
    const response = await axios.get(mediaUrl, {
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    return Buffer.from(response.data);
  }

  /**
   * Inbound media from WhatsApp is delivered as an encrypted .enc URL on
   * mmg.whatsapp.net that the browser cannot play. Uazapi exposes
   * /message/download which decrypts server-side and returns a playable
   * URL on their own CDN. We hit that, then the caller can either redirect
   * clients to it or fetch bytes for transcription.
   */
  async resolveInboundMediaUrl(
    channel: Channel,
    externalMessageId: string,
  ): Promise<{ fileUrl: string; mimeType?: string }> {
    const response = await this.sendRequest(channel, '/message/download', {
      id: externalMessageId,
    });
    const fileUrl: string | undefined = response?.fileURL || response?.fileUrl;
    if (!fileUrl) {
      throw new Error(
        `Uazapi /message/download returned no fileURL for ${externalMessageId}`,
      );
    }
    return { fileUrl, mimeType: response?.mimetype };
  }

  /**
   * Apaga a mensagem pra todos no WhatsApp via Uazapi.
   * Endpoint: `POST /message/delete` com `{ id: <externalMessageId> }`.
   * Uazapi devolve 200 mesmo quando a janela do WhatsApp já passou (o
   * cliente final só vê "Esta mensagem foi apagada" se for recente —
   * limitação do próprio WhatsApp, não nossa).
   */
  async deleteMessage(
    channel: Channel,
    externalMessageId: string,
  ): Promise<void> {
    await this.sendRequest(channel, '/message/delete', {
      id: externalMessageId,
    });
  }
}


/** Normaliza vários formatos de status do Uazapi para "conectado?". */
function uazapiConnected(data: any): boolean {
  if (!data) return false;
  const inst = data.instance ?? data;
  const st = inst?.status ?? inst?.state ?? data?.status ?? data?.state;
  const s = typeof st === 'string' ? st.toLowerCase() : '';
  return s === 'connected' || s === 'open' || inst?.connected === true;
}

/** Extrai o QR (data-URI ou base64) de vários formatos do Uazapi. */
function extractUazapiQr(data: any): string | null {
  if (!data) return null;
  const inst = data.instance ?? data;
  const raw =
    inst?.qrcode ?? inst?.qrCode ?? inst?.base64 ?? data?.qrcode ??
    data?.qrCode ?? data?.base64 ?? null;
  if (!raw || typeof raw !== 'string') return null;
  return raw.startsWith('data:') ? raw : `data:image/png;base64,${raw}`;
}
