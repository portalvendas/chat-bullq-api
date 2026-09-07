import { Injectable } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import {
  InboundChannelPort,
  ChannelLocator,
} from '../../ports/inbound-channel.port';
import { WebhookParseResult } from '../../ports/types';

/**
 * Adapter inbound "inerte" do Baileys. O Baileys NÃO usa webhook: as mensagens
 * chegam pelo socket e o `BaileysSessionManager` já as empurra pra fila
 * `inbound-messages`. Este adapter existe só pra satisfazer o contrato do
 * `ChannelAdapterRegistry` (register(inbound, outbound)) e o roteamento por
 * `channelType`. Todos os métodos de webhook são no-op.
 */
@Injectable()
export class BaileysInboundAdapter implements InboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_BAILEYS;

  extractLocators(): ChannelLocator[] {
    return [];
  }

  matchesChannel(_channel: Channel, _locator: ChannelLocator): boolean {
    return false;
  }

  validateWebhook(): boolean {
    return false;
  }

  parseWebhook(_payload: unknown, _channel?: Channel): WebhookParseResult {
    return { messages: [], statuses: [], errors: [] };
  }
}
