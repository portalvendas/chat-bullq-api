import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ChannelType, Channel } from '@prisma/client';
import axios from 'axios';
import { audioBufferToMp3 } from '../../../../common/audio-convert.util';
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

  private static readonly MEDIA_TYPES = new Set<MessageContentType>([
    MessageContentType.IMAGE,
    MessageContentType.VIDEO,
    MessageContentType.AUDIO,
    MessageContentType.DOCUMENT,
    MessageContentType.STICKER,
  ]);

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    // TODA MÍDIA: sobe os bytes pro /media da Meta e envia por `id` (durável),
    // em vez de `link`. Por link a Meta re-busca a nossa URL e, se ela sumir
    // (retenção 45d / não-pública), o destinatário vê "mídia não disponível".
    // Enviando por id a Cloud API guarda a própria cópia. (Áudio OGG também é
    // convertido p/ MP3 aqui — o Cloud API não serve OGG de forma confiável.)
    await this.ensureUploadedMediaId(channel, message);

    const payload = this.mapper.denormalize(message, contactExternalId);
    const response = await this.httpClient.sendMessage(channel, payload);

    return {
      externalId: response?.messages?.[0]?.id || '',
      providerResponse: response,
    };
  }

  /**
   * Para QUALQUER mídia (imagem/vídeo/áudio/documento/sticker): baixa o arquivo
   * da nossa `mediaUrl`, faz upload pro /media da Cloud API e grava o `mediaId`
   * em message.content pro mapper montar `{ <tipo>: { id } }`. Erros de upload
   * sobem (a mensagem vira FAILED e fica visível) em vez de cair no link
   * quebrado. Best-effort tipado: sem mediaUrl ou já com mediaId, não faz nada.
   */
  private async ensureUploadedMediaId(
    channel: Channel,
    message: NormalizedOutboundMessage,
  ): Promise<void> {
    if (!WhatsAppOfficialOutboundAdapter.MEDIA_TYPES.has(message.type)) return;
    const content = (message.content ?? {}) as Record<string, any>;
    if (content.mediaId || !content.mediaUrl) return;

    const resp = await axios.get<ArrayBuffer>(content.mediaUrl, {
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    let uploadBuffer: Buffer = Buffer.from(resp.data);
    const fetchedType = resp.headers['content-type'] as string | undefined;
    // Usa o content-type real do arquivo servido (mais confiável que o mime
    // que veio na mensagem, que pode estar desatualizado após transcode).
    let uploadMime = fetchedType || content.mimeType || 'application/octet-stream';
    let uploadName = content.fileName || 'arquivo';

    // ÁUDIO OGG → MP3: a Meta aceita o OGG no /media mas não serve direito
    // ("áudio não está mais disponível"). MP3 toca em qualquer WhatsApp.
    if (message.type === MessageContentType.AUDIO && uploadMime.includes('ogg')) {
      try {
        uploadBuffer = await audioBufferToMp3(uploadBuffer);
        uploadMime = 'audio/mpeg';
        uploadName = 'audio.mp3';
      } catch (err: any) {
        this.logger.warn(
          `WA Official audio: ogg->mp3 falhou (${err?.message ?? err}) — envia ogg`,
        );
      }
    }

    const mediaId = await this.httpClient.uploadMedia(channel, {
      buffer: uploadBuffer,
      mimeType: uploadMime,
      filename: uploadName,
    });
    this.logger.log(
      `WA Official media: ${message.type} upload /media OK mediaId=${mediaId} ` +
        `mime=${uploadMime} bytes=${uploadBuffer.length} (envio por id)`,
    );
    content.mediaId = mediaId;
    content.mimeType = uploadMime;
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
