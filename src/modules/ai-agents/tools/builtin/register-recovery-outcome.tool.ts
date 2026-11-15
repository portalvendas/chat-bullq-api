import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../../database/prisma.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';
import { NotificationsService } from '../../../notifications/notifications.service';
import { RecoveryOfferService } from '../../../proposal-recovery/core/recovery-offer.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

type Outcome = 'NEGOTIATING' | 'ACCEPTED' | 'LOST' | 'OPT_OUT';
const OBJECTIONS = ['preco', 'frete', 'prazo', 'confianca', 'timing', 'concorrente', 'produto', 'outro'];

/**
 * Registra o desfecho da recuperação. ACCEPTED passa a conversa pro vendedor
 * da proposta (IA pausada, conversa atribuída a ele, notificação com a
 * condição escolhida). LOST/OPT_OUT encerram e devolvem a IA ao estado
 * anterior. NEGOTIATING só registra a objeção.
 *
 * Entrada (exemplo): { outcome: "ACCEPTED", paymentMethod: "PIX", notes: "quer entrega até dia 30" }
 */
@Injectable()
export class RegisterRecoveryOutcomeTool implements AiTool {
  private readonly logger = new Logger(RegisterRecoveryOutcomeTool.name);

  readonly name = 'registerRecoveryOutcome';
  readonly description =
    'Registra o andamento/desfecho da recuperação da proposta. ACCEPTED = cliente aceitou a condição (informe paymentMethod) → a conversa vai pro vendedor gerar o pagamento. NEGOTIATING = cliente levantou uma objeção (informe objection). LOST = cliente recusou (informe lostReason). OPT_OUT = cliente pediu pra não ser mais contatado. Chame ANTES de responder ao cliente.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['outcome'],
    properties: {
      outcome: { type: 'string', enum: ['NEGOTIATING', 'ACCEPTED', 'LOST', 'OPT_OUT'] },
      paymentMethod: { type: 'string', enum: ['PIX', 'CARD'] },
      objection: { type: 'string', enum: OBJECTIONS },
      lostReason: { type: 'string', maxLength: 300 },
      notes: {
        type: 'string',
        maxLength: 800,
        description: 'Resumo curto pro vendedor (o que o cliente quer, prazos, dúvidas). PT-BR.',
      },
    },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly offers: RecoveryOfferService,
    private readonly notifications: NotificationsService,
    private readonly realtime: RealtimeGateway,
  ) {}

  async execute(input: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
    const outcome = String(input.outcome ?? '') as Outcome;
    const notes = input.notes ? String(input.notes).slice(0, 800) : null;
    const recovery = await this.offers.getActiveForConversation(ctx.conversationId);
    if (!recovery) {
      return { output: { ok: false, reason: 'sem_recuperacao_ativa' } };
    }

    try {
      switch (outcome) {
        case 'NEGOTIATING': {
          const objection = OBJECTIONS.includes(String(input.objection)) ? String(input.objection) : 'outro';
          await this.prisma.proposalRecovery.update({
            where: { id: recovery.id },
            data: { status: 'ENGAGED', objection, notes: notes ?? recovery.notes },
          });
          return { output: { ok: true, status: 'ENGAGED', objection } };
        }

        case 'ACCEPTED': {
          const method = input.paymentMethod === 'CARD' ? 'CARD' : input.paymentMethod === 'PIX' ? 'PIX' : null;
          if (!method) {
            return {
              output: {
                ok: false,
                reason: 'paymentMethod_obrigatorio',
                agent_should_do: 'Pergunte ao cliente se prefere Pix ou cartão antes de registrar o aceite.',
              },
            };
          }
          if (recovery.offerExpiresAt.getTime() <= Date.now()) {
            return {
              output: {
                ok: false,
                reason: 'condicao_expirada',
                agent_should_do: 'A condição venceu. Não confirme os valores; chame transferToHuman pra o vendedor avaliar.',
              },
            };
          }
          await this.handoffToVendor(recovery, method, notes, ctx);
          return {
            output: {
              ok: true,
              status: 'HANDED_OFF',
              agent_should_say: `Confirme com entusiasmo e naturalidade que a condição ${method === 'PIX' ? 'no Pix' : 'no cartão'} está garantida e que ${recovery.vendorName ?? 'o vendedor'} vai te enviar ${method === 'PIX' ? 'a chave/QR Code do Pix' : 'o link de pagamento'} e confirmar os dados de entrega em instantes. Não mencione sistema, aprovação ou transferência.`,
            },
          };
        }

        case 'LOST':
        case 'OPT_OUT': {
          await this.prisma.proposalRecovery.update({
            where: { id: recovery.id },
            data: {
              status: outcome === 'LOST' ? 'LOST' : 'OPTED_OUT',
              lostReason: input.lostReason ? String(input.lostReason).slice(0, 300) : outcome === 'OPT_OUT' ? 'opt_out' : null,
              notes: notes ?? recovery.notes,
              closedAt: new Date(),
            },
          });
          if (outcome === 'OPT_OUT') {
            await this.prisma.contact.update({
              where: { id: ctx.contactId },
              data: { broadcastOptedOutAt: new Date() },
            });
          }
          await this.offers.releaseConversation(recovery);
          return {
            output: {
              ok: true,
              status: outcome,
              agent_should_say:
                outcome === 'OPT_OUT'
                  ? 'Peça desculpas pelo incômodo em uma frase e confirme que não vai mais enviar mensagens sobre isso. Nada de insistir.'
                  : 'Agradeça com educação, deixe a porta aberta ("se mudar de ideia, é só chamar") e encerre. Nada de insistir.',
            },
          };
        }

        default:
          return { output: { ok: false, reason: 'outcome_invalido' } };
      }
    } catch (err: any) {
      this.logger.error(
        `registerRecoveryOutcome falhou (conv ${ctx.conversationId}, outcome ${outcome}): ${err?.message ?? err}`,
      );
      throw err;
    }
  }

  private async handoffToVendor(
    recovery: {
      id: string;
      vendorUserId: string | null;
      vendorName: string | null;
      offer: unknown;
      previousAiState: unknown;
      offerExpiresAt: Date;
    },
    method: 'PIX' | 'CARD',
    notes: string | null,
    ctx: ToolContext,
  ): Promise<void> {
    const prev = (recovery.previousAiState ?? {}) as { aiReviewMode?: boolean | null };
    await this.prisma.proposalRecovery.update({
      where: { id: recovery.id },
      data: { status: 'HANDED_OFF', chosenOption: method, notes, handedOffAt: new Date() },
    });
    const conv = await this.prisma.conversation.update({
      where: { id: ctx.conversationId },
      data: {
        // Humano assume: IA pausada nesta conversa.
        aiEnabled: false,
        aiDisabledAt: new Date(),
        activeAgentId: null,
        aiReviewMode: prev.aiReviewMode ?? null,
        ...(recovery.vendorUserId ? { assignedToId: recovery.vendorUserId } : {}),
      },
      select: { assignedToId: true, channelId: true },
    });

    this.realtime.emitToConversation(ctx.conversationId, 'conversation:ai-toggle', {
      conversationId: ctx.conversationId,
      aiEnabled: false,
      activeAgentId: null,
      reason: 'proposal-recovery-accepted',
    });

    const snap = recovery.offer as any;
    const o = snap?.offer;
    const cond =
      method === 'PIX' && o?.pix?.available
        ? `Pix ${o.pix.totalDiscountPct}% → R$ ${Number(o.pix.total).toFixed(2)}`
        : method === 'CARD' && o?.card?.available
          ? `Cartão ${o.card.maxInstallments}x de R$ ${Number(o.card.installmentValue).toFixed(2)} (total R$ ${Number(o.card.total).toFixed(2)}${o.card.freeShipping ? ', frete grátis' : ''})`
          : method;

    const payload = {
      organizationId: ctx.organizationId,
      type: 'CONVERSATION_ASSIGNED' as const,
      title: `Cliente aceitou a condição — proposta #${snap?.numero ?? '?'}`,
      body: `${cond}.${notes ? ` ${notes}` : ''} Envie o pagamento e atualize o orçamento no Tiny.`,
      data: { kind: 'proposal_recovery_accepted', conversationId: ctx.conversationId, recoveryId: recovery.id },
    };
    // Nota interna visível no chat (não vai pro cliente) + tag pra filtrar no inbox.
    const validade = this.offers.formatDeadline(recovery.offerExpiresAt);
    await this.offers.postInternalNote({
      conversationId: ctx.conversationId,
      channelId: conv.channelId,
      contactId: ctx.contactId,
      text: [
        `✅ Cliente ACEITOU a condição — proposta #${snap?.numero ?? '?'}`,
        `Condição: ${cond}`,
        `Válida até: ${validade}`,
        notes ? `Observações: ${notes}` : null,
        `Próximo passo: ${method === 'PIX' ? 'enviar a chave/QR Code do Pix' : 'enviar o link de pagamento do cartão'}, confirmar os dados de entrega e atualizar o orçamento no Tiny.`,
      ]
        .filter(Boolean)
        .join('\n'),
    });
    await this.offers.tagConversation(ctx.organizationId, ctx.conversationId, 'proposta-aceita');

    const recipient = recovery.vendorUserId ?? conv.assignedToId;
    if (recipient) {
      await this.notifications.notify({ recipientId: recipient, ...payload });
    } else {
      await this.notifications.notifyManagersAndUser({ ...payload, responsibleUserId: null });
    }
  }
}
