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

@Injectable()
export class ZApiOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_ZAPI;
  private readonly logger = new Logger(ZApiOutboundAdapter.name);

  constructor(
    private readonly mapper: ZApiMessageMapper,
    private readonly httpClient: ZApiHttpClient,
  ) {}

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    const { endpoint, payload } = this.mapper.denormalize(
      message,
      contactExternalId,
    );
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
