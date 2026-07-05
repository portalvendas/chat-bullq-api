import { Injectable, Logger } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import {
  InboundChannelPort,
  ChannelLocator,
} from '../../ports/inbound-channel.port';
import { WebhookParseResult } from '../../ports/types';
import { ZApiMessageMapper } from './zapi.message-mapper';

@Injectable()
export class ZApiInboundAdapter implements InboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_ZAPI;
  private readonly logger = new Logger(ZApiInboundAdapter.name);

  constructor(private readonly mapper: ZApiMessageMapper) {}

  extractLocators(payload: unknown): ChannelLocator[] {
    const event = (payload ?? {}) as Record<string, any>;
    const instanceId = event?.instanceId
      ? String(event.instanceId)
      : undefined;
    return [instanceId ? { instanceId } : {}];
  }

  matchesChannel(channel: Channel, locator: ChannelLocator): boolean {
    const config = (channel.config ?? {}) as Record<string, any>;
    if (locator.instanceId && config.instanceId) {
      return String(config.instanceId) === String(locator.instanceId);
    }
    return false;
  }

  validateWebhook(): boolean {
    // Z-API não assina webhooks (sem HMAC/secret no payload). A autenticidade
    // vem do match por `instanceId` (32 hex, não trivial) em matchesChannel.
    // Endurecimento futuro: exigir um `?token=` na URL do webhook.
    return true;
  }

  parseWebhook(payload: unknown, _channel?: Channel): WebhookParseResult {
    const result: WebhookParseResult = {
      messages: [],
      statuses: [],
      errors: [],
    };
    try {
      const event = payload as any;
      const type = event?.type;
      if (type === 'ReceivedCallback') {
        const msg = this.mapper.normalizeInbound(event);
        if (msg) result.messages.push(msg);
      } else if (
        type === 'MessageStatusCallback' ||
        type === 'DeliveryCallback'
      ) {
        const status = this.mapper.normalizeStatus(event);
        if (status) result.statuses.push(status);
      }
    } catch (error: any) {
      this.logger.error(`Failed to parse Z-API webhook: ${error.message}`);
      result.errors.push({
        code: 'PARSE_ERROR',
        message: error.message,
        rawData: payload,
      });
    }
    return result;
  }
}
