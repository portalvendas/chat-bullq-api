import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, Channel } from '@prisma/client';
import { OutboundChannelPort } from '../../ports/outbound-channel.port';
import {
  NormalizedOutboundMessage,
  SendResult,
  RateLimitConfig,
} from '../../ports/types';
import { ZApiMessageMapper } from './zapi.message-mapper';
import { ZApiHttpClient } from './zapi.http-client';
import { PrismaService } from '../../../../database/prisma.service';

@Injectable()
export class ZApiOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_ZAPI;
  private readonly logger = new Logger(ZApiOutboundAdapter.name);

  constructor(
    private readonly mapper: ZApiMessageMapper,
    private readonly httpClient: ZApiHttpClient,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * O contato agora é chaveado pelo LID (dedup inbound/outbound), mas o Z-API
   * exige o NÚMERO REAL no /send-text. Resolve o número real a partir do
   * contato; se não houver (ex.: lead só de broadcast, nunca respondeu), cai
   * no próprio externalId como último recurso.
   */
  private async resolveSendPhone(
    channelId: string,
    externalId: string,
  ): Promise<string> {
    try {
      const cc = await this.prisma.contactChannel.findUnique({
        where: {
          uq_contact_channel_external: { channelId, externalId },
        },
        include: { contact: { select: { phone: true } } },
      });
      const phone = cc?.contact?.phone?.replace(/\D/g, '');
      if (phone) return phone;
    } catch (err: any) {
      this.logger.warn(
        `resolveSendPhone falhou (${externalId}): ${err?.message}`,
      );
    }
    return externalId.replace(/\D/g, '');
  }

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    const sendPhone = await this.resolveSendPhone(
      channel.id,
      contactExternalId,
    );
    const { endpoint, payload } = this.mapper.denormalize(message, sendPhone);
    const response = await this.httpClient.sendRequest(
      channel,
      endpoint,
      payload,
    );
    return {
      // Z-API devolve { zaapId, messageId, id }. messageId = id do WhatsApp,
      // que é o que volta nos webhooks de status → casa o merge do placeholder.
      externalId:
        response?.messageId || response?.id || response?.zaapId || '',
      providerResponse: response,
    };
  }

  async sendTypingIndicator(): Promise<void> {
    // Fase 2 (Z-API: /send-chat-state). No-op no MVP.
  }

  async getMediaUrl(_channel: Channel, mediaId: string): Promise<string> {
    return mediaId;
  }

  async downloadMedia(channel: Channel, mediaId: string): Promise<Buffer> {
    return this.httpClient.getMediaBuffer(channel, mediaId);
  }

  getRateLimits(): RateLimitConfig {
    return { maxPerSecond: 1, maxPerMinute: 30, windowMs: 60000 };
  }
}
