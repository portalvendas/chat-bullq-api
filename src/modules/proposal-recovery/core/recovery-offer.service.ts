import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { TinyService } from '../../tiny-erp/tiny.service';
import {
  computeRecoveryOffer,
  DEFAULT_RECOVERY_POLICY,
  RecoveryOffer,
} from './offer-policy';
import { ACTIVE_RECOVERY_STATUSES } from '../proposal-recovery.constants';

export interface ProposalSnapshot {
  tinyDocumentId: string;
  numero: string | null;
  data: string | null;
  vendedor: string | null;
  items: Array<{ descricao: string; sku: string | null; quantidade: number }>;
  offer: RecoveryOffer;
}

/**
 * Núcleo da recuperação SEM dependência do runner de IA (evita ciclo
 * ToolsModule ↔ AiAgentsModule): lê a proposta do Tiny, calcula a oferta e
 * consulta a recuperação ativa da conversa. Usado pelas tools e pelo scan.
 */
@Injectable()
export class RecoveryOfferService {
  private readonly logger = new Logger(RecoveryOfferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tiny: TinyService,
  ) {}

  /**
   * Busca o detalhe do orçamento no Tiny e calcula a oferta.
   * Lança se o Tiny estiver fora — quem chama decide (scan pula, tool avisa).
   */
  async buildSnapshot(
    organizationId: string,
    tinyDocumentId: string,
  ): Promise<ProposalSnapshot> {
    const doc = await this.prisma.tinyDocument.findFirstOrThrow({
      where: { id: tinyDocumentId, organizationId },
      select: { id: true, numero: true, data: true, vendedor: true, valor: true },
    });
    const { items, resumo } = await this.tiny.getItems(organizationId, doc.id);

    const shipping = Number(resumo.frete ?? 0);
    const vendorDiscount = Number(resumo.desconto ?? 0);
    // Sem total de produtos no detalhe: reconstrói a partir do total do doc.
    const grossProducts =
      resumo.totalProdutos != null
        ? Number(resumo.totalProdutos)
        : Math.max(0, Number(resumo.total ?? doc.valor ?? 0) - shipping + vendorDiscount);

    const offer = computeRecoveryOffer(
      { grossProducts, vendorDiscount, shipping },
      DEFAULT_RECOVERY_POLICY,
    );

    return {
      tinyDocumentId: doc.id,
      numero: doc.numero,
      data: doc.data ? doc.data.toISOString().slice(0, 10) : null,
      vendedor: doc.vendedor,
      items: items.map((i) => ({
        descricao: i.descricao,
        sku: i.sku,
        quantidade: i.quantidade,
      })),
      offer,
    };
  }

  /** Recuperação viva (CONTACTED/ENGAGED) da conversa, se houver. */
  getActiveForConversation(conversationId: string) {
    return this.prisma.proposalRecovery.findFirst({
      where: {
        conversationId,
        status: { in: [...ACTIVE_RECOVERY_STATUSES] },
      },
      orderBy: { kickedOffAt: 'desc' },
    });
  }

  /**
   * Devolve a conversa ao estado de IA anterior à abordagem (quando ainda está
   * fixada no agente de recuperação). Best-effort: nunca derruba o fluxo.
   */
  async releaseConversation(recovery: {
    conversationId: string;
    agentId: string | null;
    previousAiState: unknown;
  }): Promise<void> {
    try {
      const prev = (recovery.previousAiState ?? {}) as {
        aiEnabled?: boolean | null;
        activeAgentId?: string | null;
        aiReviewMode?: boolean | null;
      };
      await this.prisma.conversation.updateMany({
        where: { id: recovery.conversationId, activeAgentId: recovery.agentId },
        data: {
          aiEnabled: prev.aiEnabled ?? null,
          activeAgentId: prev.activeAgentId ?? null,
          aiReviewMode: prev.aiReviewMode ?? null,
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `releaseConversation falhou (conv ${recovery.conversationId}): ${err?.message ?? err}`,
      );
    }
  }

  /** "sexta-feira, 15/11 às 14h30" no fuso de São Paulo. */
  formatDeadline(d: Date): string {
    const parts = new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      weekday: 'long',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const min = get('minute');
    return `${get('weekday')}, ${get('day')}/${get('month')} às ${get('hour')}h${min === '00' ? '' : min}`;
  }
}
