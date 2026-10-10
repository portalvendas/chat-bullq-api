import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ChannelType, Channel } from '@prisma/client';
import axios from 'axios';
import { OutboundChannelPort, ResolveMediaHint } from '../../ports/outbound-channel.port';
import {
  NormalizedOutboundMessage,
  SendResult,
  RateLimitConfig,
  MessageContentType,
} from '../../ports/types';
import { WhatsAppOfficialMessageMapper } from './whatsapp-official.message-mapper';
import { WhatsAppOfficialHttpClient } from './whatsapp-official.http-client';
import { UploadsService } from '../../../messaging/messages/uploads.service';

@Injectable()
export class WhatsAppOfficialOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_OFFICIAL;
  private readonly logger = new Logger(WhatsAppOfficialOutboundAdapter.name);

  constructor(
    private readonly mapper: WhatsAppOfficialMessageMapper,
    private readonly httpClient: WhatsAppOfficialHttpClient,
    private readonly uploads: UploadsService,
  ) {}

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    // ÁUDIO: sobe os bytes pro /media da Meta e envia por `id` (durável), em vez
    // de `link`. Por link o destinatário via "áudio não está mais disponível"
    // quando a Meta re-buscava a URL (não-pública / purgada pela retenção).
    // A Cloud API guarda a própria cópia quando enviado por id.
    await this.ensureUploadedMediaId(channel, message);

    const payload = this.mapper.denormalize(message, contactExternalId);
    const response = await this.httpClient.sendMessage(channel, payload);

    return {
      externalId: response?.messages?.[0]?.id || '',
      providerResponse: response,
    };
  }

  /**
   * Para ÁUDIO: baixa o arquivo da nossa `mediaUrl` e faz upload pro endpoint
   * /media da Cloud API, gravando o `mediaId` resolvido em message.content pra
   * o mapper montar `{ audio: { id } }`. Best-effort tipado: se faltar mediaUrl
   * ou já houver mediaId, não faz nada. Erros de upload sobem (mensagem vira
   * FAILED e fica visível) em vez de cair no link quebrado.
   */
  private async ensureUploadedMediaId(
    channel: Channel,
    message: NormalizedOutboundMessage,
  ): Promise<void> {
    if (message.type !== MessageContentType.AUDIO) return;
    const content = (message.content ?? {}) as Record<string, any>;
    if (content.mediaId || !content.mediaUrl) return;

    const resp = await axios.get<ArrayBuffer>(content.mediaUrl, {
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    const buffer = Buffer.from(resp.data);
    const fetchedType = resp.headers['content-type'] as string | undefined;
    // Usa SEMPRE o content-type real do arquivo servido (ex.: audio/ogg) e não
    // o mimeType que veio na mensagem — se o arquivo foi transcodado p/ ogg, é
    // o content-type servido que vale pro /media da Meta.
    const mimeType = fetchedType || content.mimeType || 'audio/ogg';
    const filename =
      content.fileName || `audio.${mimeType.includes('ogg') ? 'ogg' : 'bin'}`;

    this.logger.log(
      `WA Official audio: baixando p/ /media url=${content.mediaUrl} ` +
        `bytes=${buffer.length} fetchType=${fetchedType ?? '?'} mime=${mimeType}`,
    );

    const mediaId = await this.httpClient.uploadMedia(channel, {
      buffer,
      mimeType,
      filename,
    });
    this.logger.log(
      `WA Official audio: upload /media OK mediaId=${mediaId} (envio por id)`,
    );
    content.mediaId = mediaId;
    message.content = content as any;
  }

  async sendTypingIndicator(_channel: Channel, _contactExternalId: string): Promise<void> {
    // Meta Cloud API doesn't support typing indicators via API
  }

  async getMediaUrl(channel: Channel, mediaId: string): Promise<string> {
    return this.httpClient.getMediaUrl(channel, mediaId);
  }

  async downloadMedia(channel: Channel, mediaId: string): Promise<Buffer> {
    const url = await this.httpClient.getMediaUrl(channel, mediaId);
    return this.httpClient.downloadMedia(channel, url);
  }

  /**
   * Meta Cloud's media URL is a Graph CDN link that requires the WABA's
   * bearer token to GET — browsers cannot load it directly. We download
   * once with the token and re-host the bytes under our own
   * `/api/v1/uploads/inbound/...` so the frontend can render it like any
   * other static asset and the cached URL keeps working past Meta's
   * 5-minute signed-URL window.
   */
  async resolveInboundMediaUrl(
    channel: Channel,
    hint: ResolveMediaHint,
  ): Promise<{ fileUrl: string; mimeType?: string }> {
    if (!hint.mediaId) {
      throw new BadRequestException(
        'WhatsApp Official media resolution requires a stored mediaId',
      );
    }
    const buffer = await this.downloadMedia(channel, hint.mediaId);
    const saved = await this.uploads.saveInboundMedia({
      buffer,
      mimeType: hint.mimeType || 'application/octet-stream',
      channelId: channel.id,
      originalFilename: hint.originalFilename ?? null,
    });
    return { fileUrl: saved.url, mimeType: saved.mimeType };
  }

  /**
   * Meta Cloud API NÃO suporta delete de mensagem — não existe endpoint
   * público pra remover uma mensagem já enviada. Lançamos erro claro pra
   * que o service de delete capture e siga com soft-delete (marca como
   * revoked apenas no nosso lado, mas a mensagem permanece visível pro
   * cliente final no WhatsApp dele).
   */
  async deleteMessage(
    _channel: Channel,
    externalMessageId: string,
  ): Promise<void> {
    throw new Error(
      `WhatsApp Cloud API does not support message deletion (id=${externalMessageId}). ` +
        'Marcamos a mensagem como deletada apenas no Kortia CRM — ' +
        'no app do cliente ela continua existindo (limitação da Meta).',
    );
  }

  getRateLimits(): RateLimitConfig {
    return {
      maxPerSecond: 80,
      maxPerMinute: 1000,
      windowMs: 60000,
    };
  }
}
