import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, Channel } from '@prisma/client';
import { OutboundChannelPort } from '../../ports/outbound-channel.port';
import {
  NormalizedOutboundMessage,
  SendResult,
  RateLimitConfig,
} from '../../ports/types';
import { ZappfyMessageMapper } from './zappfy.message-mapper';
import { ZappfyHttpClient } from './zappfy.http-client';

@Injectable()
export class ZappfyOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_ZAPPFY;
  private readonly logger = new Logger(ZappfyOutboundAdapter.name);

  constructor(
    private readonly mapper: ZappfyMessageMapper,
    private readonly httpClient: ZappfyHttpClient,
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
      // Prefer `messageid` — the send response returns `id` as `<owner>:<msgid>`
      // but webhook echoes only carry the bare `<msgid>` in `messageid`. Using
      // the same shape on both sides keeps the unique (conversationId,externalId)
      // matching so the echo merges into our placeholder instead of duplicating.
      externalId:
        response?.messageid ||
        response?.key?.id ||
        response?.id ||
        '',
      providerResponse: response,
    };
  }

  async sendTypingIndicator(
    channel: Channel,
    contactExternalId: string,
  ): Promise<void> {
    const number = contactExternalId.replace(/@s\.whatsapp\.net|@g\.us/g, '');
    try {
      await this.httpClient.sendRequest(channel, '/message/presence', {
        number,
        presence: 'composing',
      });
    } catch (error: any) {
      this.logger.warn(`Typing indicator failed: ${error.message}`);
    }
  }

  async getMediaUrl(channel: Channel, mediaId: string): Promise<string> {
    return mediaId;
  }

  async downloadMedia(channel: Channel, mediaId: string): Promise<Buffer> {
    return this.httpClient.getMediaBuffer(channel, mediaId);
  }

  async resolveInboundMediaUrl(
    channel: Channel,
    hint: { externalMessageId: string },
  ): Promise<{ fileUrl: string; mimeType?: string }> {
    return this.httpClient.resolveInboundMediaUrl(channel, hint.externalMessageId);
  }

  async deleteMessage(
    channel: Channel,
    externalMessageId: string,
  ): Promise<void> {
    await this.httpClient.deleteMessage(channel, externalMessageId);
  }

  getRateLimits(): RateLimitConfig {
    return {
      maxPerSecond: 1,
      maxPerMinute: 30,
      windowMs: 60000,
    };
  }
}
