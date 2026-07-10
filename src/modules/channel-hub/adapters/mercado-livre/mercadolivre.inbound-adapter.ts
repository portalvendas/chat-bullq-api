import { Injectable } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import {
  InboundChannelPort,
  ChannelLocator,
} from '../../ports/inbound-channel.port';
import { WebhookParseResult } from '../../ports/types';

/**
 * Adapter inbound "mínimo" só para satisfazer o registry (o outbound precisa
 * estar registrado). O recebimento REAL do Mercado Livre NÃO passa por aqui:
 * as notificações são em 2 passos e são tratadas pelo
 * MercadoLivreWebhookController + MercadoLivreQuestionsProcessor.
 */
@Injectable()
export class MercadoLivreInboundAdapter implements InboundChannelPort {
  readonly channelType = ChannelType.MERCADO_LIVRE;

  extractLocators(): ChannelLocator[] {
    return [{}];
  }

  matchesChannel(channel: Channel, locator: ChannelLocator): boolean {
    const cfg = (channel.config ?? {}) as Record<string, any>;
    return !!locator.instanceId && String(cfg.sellerId) === locator.instanceId;
  }

  validateWebhook(): boolean {
    return true;
  }

  parseWebhook(): WebhookParseResult {
    // Fluxo real é no controller/processor dedicados.
    return { messages: [], statuses: [], errors: [] };
  }
}
