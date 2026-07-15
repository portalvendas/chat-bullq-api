import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, Channel } from '@prisma/client';
import { OutboundChannelPort } from '../../ports/outbound-channel.port';
import {
  NormalizedOutboundMessage,
  SendResult,
  RateLimitConfig,
} from '../../ports/types';
import { ShopeeMessageMapper } from './shopee.message-mapper';
import { ShopeeHttpClient } from './shopee.http-client';

/**
 * Envio para o Shopee Chat — responde o comprador via
 * POST /api/v2/sellerchat/send_message. `contactExternalId` = id do comprador
 * (to_id), que o mapper guardou como externalContactId na conversa.
 */
@Injectable()
export class ShopeeOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.SHOPEE;
  private readonly logger = new Logger(ShopeeOutboundAdapter.name);
  private static readonly PATH_SEND = '/api/v2/sellerchat/send_message';

  constructor(
    private readonly mapper: ShopeeMessageMapper,
    private readonly httpClient: ShopeeHttpClient,
  ) {}

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    const payload = this.mapper.denormalizeSend(
      contactExternalId,
      message.content.text ?? '',
    );
    const response = await this.httpClient.post(
      channel,
      ShopeeOutboundAdapter.PATH_SEND,
      payload,
    );
    const messageId =
      response?.response?.message_id ?? response?.message_id ?? Date.now();
    this.logger.log(
      `Shopee: resposta enviada ao comprador ${contactExternalId} (msg ${messageId})`,
    );
    return {
      externalId: `shp-${messageId}`,
      providerResponse: response,
    };
  }

  async sendTypingIndicator(): Promise<void> {
    // Não se aplica.
  }

  async getMediaUrl(_channel: Channel, mediaId: string): Promise<string> {
    return mediaId;
  }

  async downloadMedia(): Promise<Buffer> {
    throw new Error('Shopee (chat) não suporta download de mídia nesta fase');
  }

  getRateLimits(): RateLimitConfig {
    return { maxPerSecond: 2, maxPerMinute: 60, windowMs: 60000 };
  }
}
