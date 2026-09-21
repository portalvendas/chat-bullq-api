import { Injectable } from '@nestjs/common';
import { Prisma, BudgetPeriod } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface BudgetUsage {
  capMicros: bigint;
  committedMicros: bigint; // ΣRESERVE − ΣRELEASE (segurado contra o teto)
  chargedMicros: bigint; // ΣCHARGE (gasto real já cobrado)
  availableMicros: bigint; // cap − committed (nunca negativo)
  period: BudgetPeriod;
  hasCap: boolean;
}

/**
 * Uso do teto de disparos. `committed` = reservas ainda seguradas; converge
 * para o total cobrado após a finalização (RELEASE devolve a sobra).
 */
@Injectable()
export class BroadcastBudgetService {
  constructor(private readonly prisma: PrismaService) {}

  /** Início da janela do período (MONTHLY = 1º dia do mês UTC; TOTAL = época). */
  private periodStart(period: BudgetPeriod): Date {
    if (period === 'TOTAL') return new Date(0);
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  }

  async getUsage(organizationId: string): Promise<BudgetUsage> {
    const budget = await this.prisma.organizationBroadcastBudget.findUnique({
      where: { organizationId },
    });
    const period = budget?.period ?? 'MONTHLY';
    const capMicros = budget?.capMicros ?? 0n;
    const from = this.periodStart(period);

    const sums = await this.prisma.broadcastLedgerEntry.groupBy({
      by: ['type'],
      where: { organizationId, createdAt: { gte: from } },
      _sum: { amountMicros: true },
    });
    const by = (t: string): bigint =>
      sums.find((s) => s.type === t)?._sum.amountMicros ?? 0n;

    const committedMicros = by('RESERVE') - by('RELEASE');
    const chargedMicros = by('CHARGE');
    const available = capMicros - committedMicros;

    return {
      capMicros,
      committedMicros,
      chargedMicros,
      availableMicros: available > 0n ? available : 0n,
      period,
      hasCap: !!budget && capMicros > 0n,
    };
  }

  /** Define/atualiza o teto da empresa (admin). */
  async setCap(
    organizationId: string,
    capMicros: bigint,
    period: BudgetPeriod = 'MONTHLY',
  ) {
    const data: Prisma.OrganizationBroadcastBudgetUncheckedCreateInput = {
      organizationId,
      capMicros,
      period,
    };
    return this.prisma.organizationBroadcastBudget.upsert({
      where: { organizationId },
      create: data,
      update: { capMicros, period },
    });
  }
}
