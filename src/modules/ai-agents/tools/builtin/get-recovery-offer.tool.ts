import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { RecoveryOfferService } from '../../../proposal-recovery/core/recovery-offer.service';
import type { RecoveryOffer } from '../../../proposal-recovery/core/offer-policy';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

const brl = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Devolve a proposta em recuperação desta conversa + as condições JÁ
 * CALCULADAS pelo motor de oferta (snapshot congelado na abordagem — os
 * números não mudam no meio da negociação). O agente NUNCA calcula valores.
 *
 * Saída (exemplo):
 * { ok: true, expired: false, vendedor: "Ana", proposta: { numero: "4821", ... },
 *   condicoes: { pix: { texto: "Pix com 13% de desconto: R$ 3.564,30 ..." },
 *                cartao: { texto: "Até 10x sem juros de R$ 369,55 + frete grátis" } },
 *   validade: { iso: "...", texto: "terça-feira, 17/11 às 14h" } }
 */
@Injectable()
export class GetRecoveryOfferTool implements AiTool {
  private readonly logger = new Logger(GetRecoveryOfferTool.name);

  readonly name = 'getRecoveryOffer';
  readonly description =
    'Retorna a proposta comercial (orçamento) que está em recuperação nesta conversa, o vendedor responsável e as condições especiais JÁ CALCULADAS (Pix e cartão), com a data/hora real de validade. Chame SEMPRE antes de falar de valores, descontos, parcelas, frete ou prazo da condição. Use apenas os números retornados aqui — nunca calcule nem invente valores.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    properties: {},
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly offers: RecoveryOfferService,
  ) {}

  async execute(_input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const recovery = await this.offers.getActiveForConversation(ctx.conversationId);
    if (!recovery) {
      return {
        output: {
          ok: false,
          reason: 'sem_recuperacao_ativa',
          agent_should_do:
            'Não há condição especial ativa nesta conversa. Não ofereça desconto; se o cliente quiser fechar, use transferToHuman.',
        },
      };
    }

    // Cliente respondeu depois da abordagem → em negociação.
    if (recovery.status === 'CONTACTED') {
      const replied = await this.prisma.message.findFirst({
        where: {
          conversationId: ctx.conversationId,
          direction: 'INBOUND',
          createdAt: { gt: recovery.kickedOffAt },
        },
        select: { id: true },
      });
      if (replied) {
        await this.prisma.proposalRecovery.update({
          where: { id: recovery.id },
          data: { status: 'ENGAGED' },
        });
      }
    }

    const snap = recovery.offer as unknown as {
      numero: string | null;
      data: string | null;
      items: Array<{ descricao: string; quantidade: number }>;
      offer: RecoveryOffer;
    };
    const o = snap.offer;
    const expired = recovery.offerExpiresAt.getTime() <= Date.now();

    const pix = o.pix.available
      ? {
          disponivel: true,
          descontoTotalPct: o.pix.totalDiscountPct,
          totalProdutos: o.pix.productsTotal,
          frete: o.pix.shipping,
          total: o.pix.total,
          economia: o.pix.savings,
          texto: `Pix com ${o.pix.totalDiscountPct}% de desconto: ${brl(o.pix.total)} (produtos ${brl(o.pix.productsTotal)}${o.pix.shipping > 0 ? ` + frete ${brl(o.pix.shipping)}` : ''}) — economia de ${brl(o.pix.savings)}`,
        }
      : { disponivel: false };
    const cartao = o.card.available
      ? {
          disponivel: true,
          descontoTotalPct: o.card.totalDiscountPct,
          parcelas: o.card.maxInstallments,
          valorParcela: o.card.installmentValue,
          freteGratis: o.card.freeShipping,
          total: o.card.total,
          economia: o.card.savings,
          texto: `Cartão em até ${o.card.maxInstallments}x sem juros de ${brl(o.card.installmentValue)} (total ${brl(o.card.total)}, com ${o.card.totalDiscountPct}% de desconto${o.card.freeShipping ? ' e FRETE GRÁTIS' : o.card.shipping > 0 ? `, frete ${brl(o.card.shipping)} incluso` : ''})`,
        }
      : { disponivel: false };

    return {
      output: {
        ok: true,
        expired,
        vendedor: recovery.vendorName ?? null,
        proposta: {
          numero: snap.numero,
          data: snap.data,
          itens: snap.items.map((i) => `${i.quantidade}x ${i.descricao}`),
          totalOriginal: o.original.total,
          descontoJaConcedidoPct: o.original.vendorDiscountPct,
        },
        condicoes: { pix, cartao },
        regras: [
          'Oferta ÚNICA: apresente UMA condição por vez, conforme a forma de pagamento que o cliente preferir. Se ele não disse, pergunte "Pix ou cartão?" antes.',
          'Pix NUNCA vem com frete grátis.',
          'Não há margem além destas condições. Pedido de desconto maior → transferToHuman.',
        ],
        validade: {
          iso: recovery.offerExpiresAt.toISOString(),
          texto: this.offers.formatDeadline(recovery.offerExpiresAt),
        },
        agent_should_do: expired
          ? 'A condição VENCEU. Não ofereça mais esses valores. Diga com naturalidade que a condição especial expirou e que vai pedir pro vendedor verificar o que ainda consegue; então chame transferToHuman.'
          : 'Use estes números exatamente. A validade é real: pode citá-la como prazo (urgência verdadeira).',
      },
    };
  }
}
