import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { MessageCategory } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/**
 * Tarifa vigente do rate card (repasse puro do preço Meta em BRL). É a fonte da
 * ESTIMATIVA; o custo REAL vem do pricing do webhook (reconciliado depois).
 */
@Injectable()
export class BroadcastPricingService {
  private readonly logger = new Logger(BroadcastPricingService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Tarifa unitária em micros para (país, categoria) vigente em `at`. */
  async getUnitMicros(
    countryCode: string,
    category: MessageCategory,
    at: Date = new Date(),
  ): Promise<bigint> {
    const row = await this.prisma.messagePricing.findFirst({
      where: {
        countryCode,
        category,
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: { effectiveFrom: 'desc' },
    });
    if (!row) {
      throw new NotFoundException(
        `Sem tarifa vigente para ${countryCode}/${category}. Configure o rate card.`,
      );
    }
    return row.amountMicros;
  }

  /** Rate card vigente (todas as categorias de um país) — pra tela. */
  async currentRateCard(countryCode = 'BR', at: Date = new Date()) {
    const rows = await this.prisma.messagePricing.findMany({
      where: {
        countryCode,
        effectiveFrom: { lte: at },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: at } }],
      },
      orderBy: [{ category: 'asc' }, { effectiveFrom: 'desc' }],
    });
    // Mantém só a mais recente por categoria.
    const byCat = new Map<MessageCategory, (typeof rows)[number]>();
    for (const r of rows) if (!byCat.has(r.category)) byCat.set(r.category, r);
    return [...byCat.values()].map((r) => ({
      category: r.category,
      amountMicros: r.amountMicros,
      currency: r.currency,
      effectiveFrom: r.effectiveFrom,
    }));
  }
}
