import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { TinyService } from '../../tiny-erp/tiny.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
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
    private readonly realtime: RealtimeGateway,
  ) {}

  /**
   * Nota interna na conversa: Message type SYSTEM, gravada direto (NÃO entra
   * na fila de envio → nunca chega ao cliente). O inbox renderiza como
   * destaque amarelo; o agente e a prévia da lista ignoram SYSTEM.
   * Best-effort: falha só loga.
   */
  async postInternalNote(args: {
    conversationId: string;
    channelId?: string | null;
    contactId?: string | null;
    text: string;
  }): Promise<void> {
    try {
      const message = await this.prisma.message.create({
        data: {
          conversationId: args.conversationId,
          direction: 'OUTBOUND',
          type: 'SYSTEM',
          content: { text: args.text },
          status: 'SENT',
          senderName: 'Nota interna',
          metadata: { internalNote: true, source: 'proposal-recovery' },
        },
      });
      if (args.channelId) {
        this.realtime.emitToChannel(args.channelId, 'message:new', {
          message,
          conversationId: args.conversationId,
          contactId: args.contactId,
        });
      }
      this.realtime.emitToConversation(args.conversationId, 'message:new', { message });
    } catch (err: any) {
      this.logger.warn(`postInternalNote falhou (conv ${args.conversationId}): ${err?.message ?? err}`);
    }
  }

  /** Aplica uma tag na conversa (cria a tag na org se não existir). Best-effort. */
  async tagConversation(organizationId: string, conversationId: string, name: string, color = '#16a34a') {
    try {
      const tag = await this.prisma.tag.upsert({
        where: { organizationId_name: { organizationId, name } },
        create: { organizationId, name, color },
        update: {},
      });
      await this.prisma.conversationTag.createMany({
        data: [{ conversationId, tagId: tag.id }],
        skipDuplicates: true,
      });
    } catch (err: any) {
      this.logger.warn(`tagConversation falhou (conv ${conversationId}, ${name}): ${err?.message ?? err}`);
    }
  }

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
