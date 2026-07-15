import { Injectable } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import {
  InboundChannelPort,
  ChannelLocator,
} from '../../ports/inbound-channel.port';
import { WebhookParseResult } from '../../ports/types';

/**
 * Inbound "mínimo" só pra satisfazer o registry (o outbound precisa de um par).
 * O recebimento REAL do Shopee é via ShopeeWebhookController +
 * ShopeeMessagesProcessor (push nível partner, roteado por shop_id).
 */
@Injectable()
export class ShopeeInboundAdapter implements InboundChannelPort {
  readonly channelType = ChannelType.SHOPEE;

  extractLocators(): ChannelLocator[] {
    return [{}];
  }

  matchesChannel(channel: Channel, locator: ChannelLocator): boolean {
    const cfg = (channel.config ?? {}) as Record<string, any>;
    return !!locator.instanceId && String(cfg.shopId) === locator.instanceId;
  }

  validateWebhook(): boolean {
    return true;
  }

  parseWebhook(): WebhookParseResult {
    return { messages: [], statuses: [], errors: [] };
  }
}
