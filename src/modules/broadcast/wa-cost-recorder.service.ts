import { Injectable, Logger } from '@nestjs/common';
import { MessageCategory } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { BroadcastPricingService } from './pricing.service';

/** Categoria da Meta (string do webhook) → enum MessageCategory. */
function toCategory(raw?: string): MessageCategory | null {
  switch ((raw ?? '').toLowerCase()) {
    case 'marketing':
      return MessageCategory.MARKETING;
    case 'utility':
      return MessageCategory.UTILITY;
    case 'authentication':
    case 'authentication_international':
      return MessageCategory.AUTHENTICATION;
    case 'service':
    case 'referral_conversion':
      return MessageCategory.SERVICE;
    default:
      return null;
  }
}

interface RecordInput {
  wamid: string;
  channelId: string;
  timestamp: Date;
  pricing?: { category?: string; billable?: boolean; pricingModel?: string };
  conversation?: { id?: string; originType?: string };
}

/**
 * Grava o CUSTO REAL de cada mensagem WhatsApp Oficial a partir do `pricing` do
 * webhook de status da Meta (categoria + billable). Fonte única de custo
 * (disparo + atendimento). custo = billable ? rate card[categoria] : 0.
 * Idempotente por wamid; best-effort (nunca derruba o processamento do webhook).
 */
@Injectable()
export class WaCostRecorderService {
  private readonly logger = new Logger(WaCostRecorderService.name);
  private readonly orgCache = new Map<string, string>(); // channelId -> orgId

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: BroadcastPricingService,
  ) {}

  private async orgOf(channelId: string): Promise<string | null> {
    const cached = this.orgCache.get(channelId);
    if (cached) return cached;
    const ch = await this.prisma.channel.findUnique({
      where: { id: channelId },
      select: { organizationId: true },
    });
    if (ch?.organizationId) this.orgCache.set(channelId, ch.organizationId);
    return ch?.organizationId ?? null;
  }

  async record(input: RecordInput): Promise<void> {
    const cat = toCategory(
      input.pricing?.category ?? input.conversation?.originType,
    );
    if (!cat) return; // sem categoria confiável → não registra
    try {
      const organizationId = await this.orgOf(input.channelId);
      if (!organizationId) return;
      const billable = input.pricing?.billable ?? true;
      let costMicros = 0n;
      if (billable) {
        costMicros = await this.pricing
          .getUnitMicros('BR', cat, input.timestamp)
          .catch(() => 0n);
      }
      await this.prisma.waMessageCost.upsert({
        where: { wamid: input.wamid },
        create: {
          organizationId,
          channelId: input.channelId,
          wamid: input.wamid,
          category: cat,
          billable,
          pricingModel: input.pricing?.pricingModel ?? null,
          waConversationId: input.conversation?.id ?? null,
          originType: input.conversation?.originType ?? null,
          costMicros,
          occurredAt: input.timestamp,
        },
        // Idempotente: o primeiro status com pricing vence (não sobrescreve).
        update: {},
      });
    } catch (err) {
      this.logger.warn(
        `wa-cost record falhou wamid=${input.wamid}: ${String(err)}`,
      );
    }
  }
}
