import { Injectable, Logger } from '@nestjs/common';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

const RELEASE_AFTER_DAYS = 7;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Determinismo puro pra "quando os bônus liberam?". A LLM é ruim com
 * aritmética de datas (sempre erra fuso, sempre conta dias errado), e
 * resposta errada aqui é gasolina pra ticket de suporte. Esta tool
 * calcula sem ambiguidade: pega a purchaseDate (que a IA já tem da
 * resposta de checkPurchase), soma 7 dias, e devolve se já liberou ou
 * quantos dias faltam.
 *
 * Regra de negócio: TODO bônus do portal Bravy só libera 7 dias após a
 * compra (D+7 corrido). Antes disso, mesmo que cliente cobre, não há
 * o que fazer manualmente — a liberação é automática no portal.
 */
@Injectable()
export class CheckBonusEligibilityTool implements AiTool {
  private readonly logger = new Logger(CheckBonusEligibilityTool.name);

  readonly name = 'checkBonusEligibility';
  readonly description =
    'Calcula se os bônus de uma compra já estão liberados (regra: D+7 corridos a partir da data da compra, libera automaticamente no portal). Use SEMPRE que cliente perguntar sobre bônus / "cadê o bônus?" / aplicativos extras / brindes — passe a purchaseDate que veio da resposta de checkPurchase. Retorna eligibleNow, daysRemaining e eligibleAt.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['purchaseDate'],
    properties: {
      purchaseDate: {
        type: 'string',
        description:
          'Data da compra no formato ISO 8601 (ex: "2026-04-28T15:30:00Z"). Vem da resposta da skill checkPurchase no campo createdAt / purchaseDate / purchasedAt — passe EXATAMENTE como veio. Não invente, não ajuste fuso.',
        minLength: 8,
        maxLength: 40,
      },
    },
  };

  async execute(
    input: Record<string, unknown>,
    _ctx: ToolContext,
  ): Promise<ToolResult> {
    const raw = String(input.purchaseDate ?? '').trim();
    if (!raw) {
      return {
        output: {
          ok: false,
          error: 'purchaseDate obrigatória — passe a data exata vinda de checkPurchase.',
        },
      };
    }

    const purchaseAt = new Date(raw);
    if (Number.isNaN(purchaseAt.getTime())) {
      return {
        output: {
          ok: false,
          error: `purchaseDate inválida ("${raw}") — esperado ISO 8601.`,
        },
      };
    }

    const eligibleAt = new Date(purchaseAt.getTime() + RELEASE_AFTER_DAYS * MS_PER_DAY);
    const now = new Date();
    const diffMs = eligibleAt.getTime() - now.getTime();
    const eligibleNow = diffMs <= 0;
    const daysRemaining = eligibleNow ? 0 : Math.ceil(diffMs / MS_PER_DAY);
    const hoursRemaining = eligibleNow ? 0 : Math.ceil(diffMs / (60 * 60 * 1000));

    this.logger.log(
      `bonus eligibility: purchase=${purchaseAt.toISOString()} eligibleAt=${eligibleAt.toISOString()} eligibleNow=${eligibleNow} daysRemaining=${daysRemaining}`,
    );

    return {
      output: {
        ok: true,
        purchaseDate: purchaseAt.toISOString(),
        eligibleAt: eligibleAt.toISOString(),
        eligibleNow,
        daysRemaining,
        hoursRemaining,
        // Mensagem em PT-BR pré-formatada — a IA pode usar direto ou
        // reescrever no tom dela. Determinístico = não erra contagem.
        humanReadable: eligibleNow
          ? 'Os bônus já estão disponíveis no portal. Se cliente diz que não vê, escale pra suporte humano verificar manualmente.'
          : daysRemaining === 1
            ? 'Falta 1 dia pra liberação automática dos bônus no portal.'
            : `Faltam ${daysRemaining} dias pra liberação automática dos bônus no portal.`,
        policy:
          'Bônus liberam automaticamente 7 dias corridos após a compra. Antes disso, NÃO há liberação manual.',
      },
    };
  }
}
