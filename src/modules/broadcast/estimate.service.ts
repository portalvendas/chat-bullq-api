import { Injectable } from '@nestjs/common';
import { MessageCategory } from '@prisma/client';
import { BroadcastAudienceService, AudienceFilter } from './audience.service';
import { BroadcastPricingService } from './pricing.service';
import { BroadcastBudgetService } from './budget.service';

export interface EstimateInput {
  organizationId: string;
  filter: AudienceFilter;
  templateCategory: MessageCategory;
  countryCode?: string;
}

/**
 * Estimativa pronta pro front: destinatários × tarifa vigente = teto, e se cabe
 * no orçamento. É TETO (a cobrança real reconcilia por webhook). Roda audiência,
 * tarifa e teto em paralelo.
 */
@Injectable()
export class BroadcastEstimateService {
  constructor(
    private readonly audience: BroadcastAudienceService,
    private readonly pricing: BroadcastPricingService,
    private readonly budget: BroadcastBudgetService,
  ) {}

  async estimate(input: EstimateInput) {
    const country = input.countryCode ?? 'BR';
    const [recipients, unitMicros, usage] = await Promise.all([
      this.audience.count(input.organizationId, input.filter),
      this.pricing.getUnitMicros(country, input.templateCategory),
      this.budget.getUsage(input.organizationId),
    ]);

    const estimatedTotalMicros = unitMicros * BigInt(recipients);
    const withinBudget =
      !usage.hasCap || estimatedTotalMicros <= usage.availableMicros;

    return {
      recipients,
      unitMicros,
      estimatedTotalMicros,
      isCeiling: true, // rótulo "teto" — real vem do webhook
      country,
      category: input.templateCategory,
      budget: {
        hasCap: usage.hasCap,
        capMicros: usage.capMicros,
        availableMicros: usage.availableMicros,
        committedMicros: usage.committedMicros,
        chargedMicros: usage.chargedMicros,
        period: usage.period,
        withinBudget,
      },
    };
  }
}
