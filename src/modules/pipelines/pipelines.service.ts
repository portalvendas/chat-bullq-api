import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CardStatus, PipelineStageType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { CadencesService } from '../cadences/cadences.service';
import {
  CreateCardDto,
  CreatePipelineDto,
  MoveCardDto,
  UpdateCardDto,
  UpdatePipelineDto,
  UpsertStageDto,
} from './dto/pipeline.dto';

/** Contexto de origem do lead usado pelo roteamento origem→funil/etapa. */
export interface RoutingCtx {
  channelId?: string | null;
  channelType?: string | null;
  leadSource?: string | null; // ex.: landing_page, facebook_leadads
  utmSource?: string | null;
  leadAdsPageId?: string | null;
}

interface RoutingTarget {
  pipelineId: string;
  stageId?: string;
}
interface RoutingException extends RoutingTarget {
  id?: string;
  kind: 'CHANNEL' | 'LEADADS_PAGE' | 'UTM_SOURCE';
  value: string;
  label?: string;
}
interface LeadRouting {
  byType: Record<string, RoutingTarget>;
  exceptions: RoutingException[];
}

/** Tipos de origem suportados no roteamento por TIPO. */
export const ORIGIN_TYPES = [
  'MERCADO_LIVRE',
  'SHOPEE',
  'WHATSAPP',
  'INSTAGRAM',
  'TELEGRAM',
  'LANDING_PAGE',
  'FACEBOOK_LEADADS',
] as const;

const DEFAULT_STAGES: UpsertStageDto[] = [
  { name: 'Novo', color: 'zinc', type: 'NORMAL', order: 0 },
  { name: 'Em qualificação', color: 'blue', type: 'NORMAL', order: 1 },
  { name: 'Proposta', color: 'amber', type: 'NORMAL', order: 2 },
  { name: 'Ganho', color: 'green', type: 'WON', order: 3 },
  { name: 'Perdido', color: 'red', type: 'LOST', order: 4 },
];

@Injectable()
export class PipelinesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly cadences: CadencesService,
  ) {}

  // ─── Pipelines ─────────────────────────────────

  async listPipelines(organizationId: string, includeArchived = false) {
    return this.prisma.pipeline.findMany({
      // includeArchived=true traz também os funis desativados (arquivados),
      // usado pela tela de gestão para permitir REATIVAR. O padrão continua
      // ocultando arquivados (comportamento do board/inbox).
      where: {
        organizationId,
        ...(includeArchived ? {} : { archived: false }),
      },
      orderBy: [{ archived: 'asc' }, { order: 'asc' }, { createdAt: 'asc' }],
      include: {
        stages: { orderBy: { order: 'asc' } },
        _count: { select: { cards: true } },
      },
    });
  }

  async getBoard(pipelineId: string, organizationId: string) {
    const pipeline = await this.assertPipeline(pipelineId, organizationId);
    const [stages, cards] = await this.prisma.$transaction([
      this.prisma.pipelineStage.findMany({
        where: { pipelineId },
        orderBy: { order: 'asc' },
      }),
      this.prisma.card.findMany({
        where: { pipelineId },
        // Ordenação do board: mais novo → mais antigo (paridade com Kommo).
        // O drag-and-drop só move entre etapas; dentro da coluna a data manda.
        orderBy: { createdAt: 'desc' },
        include: {
          contact: { select: { id: true, name: true, phone: true, avatarUrl: true } },
          assignedTo: { select: { id: true, name: true, avatarUrl: true } },
          // Channel comes via the linked conversation — the kanban card UI
          // surfaces the icon (Zappfy/Meta/Instagram) so the operator can
          // tell at a glance where the conversation lives without opening it.
          conversation: {
            select: {
              id: true,
              channelId: true,
              channel: { select: { id: true, type: true, name: true } },
            },
          },
        },
      }),
    ]);

    const cardsByStage: Record<string, typeof cards> = {};
    for (const s of stages) cardsByStage[s.id] = [];
    for (const c of cards) {
      (cardsByStage[c.stageId] ||= []).push(c);
    }

    return { pipeline, stages, cards: cardsByStage };
  }

  async createPipeline(organizationId: string, dto: CreatePipelineDto) {
    const stagesIn = dto.stages?.length ? dto.stages : DEFAULT_STAGES;

    const max = await this.prisma.pipeline.findFirst({
      where: { organizationId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    const nextOrder = (max?.order ?? -1) + 1;

    return this.prisma.$transaction(async (tx) => {
      // Only one default per org — if requested, demote the others.
      if (dto.isDefault) {
        await tx.pipeline.updateMany({
          where: { organizationId, isDefault: true },
          data: { isDefault: false },
        });
      }

      const pipeline = await tx.pipeline.create({
        data: {
          organizationId,
          name: dto.name,
          description: dto.description,
          icon: dto.icon,
          color: dto.color,
          isDefault: dto.isDefault ?? false,
          order: nextOrder,
          stages: {
            create: stagesIn.map((s, i) => ({
              name: s.name,
              color: s.color,
              type: (s.type ?? 'NORMAL') as PipelineStageType,
              order: s.order ?? i,
            })),
          },
        },
        include: { stages: { orderBy: { order: 'asc' } } },
      });

      return pipeline;
    });
  }

  async updatePipeline(
    id: string,
    organizationId: string,
    dto: UpdatePipelineDto,
  ) {
    await this.assertPipeline(id, organizationId);

    return this.prisma.$transaction(async (tx) => {
      if (dto.isDefault) {
        await tx.pipeline.updateMany({
          where: { organizationId, isDefault: true, id: { not: id } },
          data: { isDefault: false },
        });
      }
      return tx.pipeline.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.description !== undefined
            ? { description: dto.description }
            : {}),
          ...(dto.icon !== undefined ? { icon: dto.icon } : {}),
          ...(dto.color !== undefined ? { color: dto.color } : {}),
          ...(dto.isDefault !== undefined ? { isDefault: dto.isDefault } : {}),
          ...(dto.archived !== undefined ? { archived: dto.archived } : {}),
          ...(dto.order !== undefined ? { order: dto.order } : {}),
        },
      });
    });
  }

  async removePipeline(id: string, organizationId: string) {
    await this.assertPipeline(id, organizationId);
    await this.prisma.pipeline.delete({ where: { id } });
  }

  // ─── Stages ────────────────────────────────────

  async upsertStages(
    pipelineId: string,
    organizationId: string,
    stages: UpsertStageDto[],
  ) {
    await this.assertPipeline(pipelineId, organizationId);

    return this.prisma.$transaction(async (tx) => {
      // Existing ids that still appear in the new list — keep them.
      const keepIds = new Set(stages.filter((s) => s.id).map((s) => s.id!));

      // Delete stages that disappeared. If they have cards, refuse — operator
      // must move/close cards first.
      const orphans = await tx.pipelineStage.findMany({
        where: {
          pipelineId,
          ...(keepIds.size > 0 ? { id: { notIn: Array.from(keepIds) } } : {}),
        },
        include: { _count: { select: { cards: true } } },
      });
      for (const o of orphans) {
        if (o._count.cards > 0) {
          throw new BadRequestException(
            `Stage "${o.name}" tem cards e não pode ser deletada — mova-os primeiro.`,
          );
        }
      }
      if (orphans.length > 0) {
        await tx.pipelineStage.deleteMany({
          where: { id: { in: orphans.map((o) => o.id) } },
        });
      }

      // Upsert each remaining stage.
      const upserts = stages.map((s, i) => {
        const data = {
          name: s.name,
          color: s.color ?? null,
          type: (s.type ?? 'NORMAL') as PipelineStageType,
          order: s.order ?? i,
        };
        return s.id
          ? tx.pipelineStage.update({ where: { id: s.id }, data })
          : tx.pipelineStage.create({
              data: { pipelineId, ...data },
            });
      });
      await Promise.all(upserts);

      return tx.pipelineStage.findMany({
        where: { pipelineId },
        orderBy: { order: 'asc' },
      });
    });
  }

  // ─── Cards ─────────────────────────────────────

  async createCard(
    pipelineId: string,
    organizationId: string,
    dto: CreateCardDto,
  ) {
    await this.assertPipeline(pipelineId, organizationId);

    // Cards represent conversations entering the pipeline. If the same
    // conversation is already in this pipeline (any stage), reject — the
    // operator should move/edit the existing card instead of duplicating.
    if (dto.conversationId) {
      const existing = await this.prisma.card.findFirst({
        where: { pipelineId, conversationId: dto.conversationId },
        select: { id: true, stageId: true },
      });
      if (existing) {
        throw new BadRequestException(
          `Essa conversa já está no pipeline (card ${existing.id}). Mova-o em vez de duplicar.`,
        );
      }
    }

    // If conversationId provided, hydrate title/contactId from the conv
    // so the operator doesn't need to retype the contact name.
    if (dto.conversationId) {
      const conv = await this.prisma.conversation.findUnique({
        where: { id: dto.conversationId },
        select: {
          id: true,
          organizationId: true,
          contactId: true,
          contact: { select: { name: true, phone: true } },
        },
      });
      if (!conv || conv.organizationId !== organizationId) {
        throw new BadRequestException('conversationId inválido');
      }
      if (!dto.title?.trim()) {
        dto.title = conv.contact.name || conv.contact.phone || 'Sem nome';
      }
      if (!dto.contactId) {
        dto.contactId = conv.contactId;
      }
    }

    // Resolve stage: explicit → use it; else first stage of the pipeline.
    let stageId = dto.stageId;
    if (!stageId) {
      const first = await this.prisma.pipelineStage.findFirst({
        where: { pipelineId },
        orderBy: { order: 'asc' },
      });
      if (!first) throw new BadRequestException('Pipeline sem stages');
      stageId = first.id;
    } else {
      const stage = await this.prisma.pipelineStage.findUnique({
        where: { id: stageId },
      });
      if (!stage || stage.pipelineId !== pipelineId) {
        throw new BadRequestException('stageId inválido pra esse pipeline');
      }
    }

    const max = await this.prisma.card.findFirst({
      where: { pipelineId, stageId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    const nextOrder = (max?.order ?? -1) + 1;

    if (!dto.title?.trim()) {
      throw new BadRequestException(
        'title é obrigatório (ou vincule uma conversationId pra derivar)',
      );
    }

    const card = await this.prisma.card.create({
      data: {
        organizationId,
        pipelineId,
        stageId,
        title: dto.title!,
        description: dto.description,
        value: dto.value as any,
        currency: dto.currency ?? 'BRL',
        contactId: dto.contactId ?? null,
        conversationId: dto.conversationId ?? null,
        assignedToId: dto.assignedToId ?? null,
        order: nextOrder,
      },
      include: {
        contact: { select: { id: true, name: true, phone: true, avatarUrl: true } },
        assignedTo: { select: { id: true, name: true, avatarUrl: true } },
      },
    });

    this.realtime.emitToOrg(organizationId, 'card:created', { card });
    return card;
  }

  async updateCard(
    cardId: string,
    organizationId: string,
    dto: UpdateCardDto,
  ) {
    const card = await this.prisma.card.findUnique({ where: { id: cardId } });
    if (!card || card.organizationId !== organizationId) {
      throw new NotFoundException('Card not found');
    }

    const updated = await this.prisma.card.update({
      where: { id: cardId },
      data: {
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.description !== undefined
          ? { description: dto.description }
          : {}),
        ...(dto.value !== undefined ? { value: dto.value as any } : {}),
        ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
        ...(dto.contactId !== undefined
          ? { contactId: dto.contactId }
          : {}),
        ...(dto.conversationId !== undefined
          ? { conversationId: dto.conversationId }
          : {}),
        ...(dto.assignedToId !== undefined
          ? { assignedToId: dto.assignedToId }
          : {}),
        ...(dto.closedReason !== undefined
          ? { closedReason: dto.closedReason }
          : {}),
      },
      include: {
        contact: { select: { id: true, name: true, phone: true, avatarUrl: true } },
        assignedTo: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
    this.realtime.emitToOrg(organizationId, 'card:updated', { card: updated });
    return updated;
  }

  async removeCard(cardId: string, organizationId: string) {
    const card = await this.prisma.card.findUnique({ where: { id: cardId } });
    if (!card || card.organizationId !== organizationId) {
      throw new NotFoundException('Card not found');
    }
    await this.prisma.card.delete({ where: { id: cardId } });
    this.realtime.emitToOrg(organizationId, 'card:deleted', {
      cardId,
      pipelineId: card.pipelineId,
    });
  }

  /**
   * Atomic drag-drop: pulls the card out of its source stage, shifts the
   * other source siblings up, makes room in the target stage at toIndex,
   * inserts the card. Updates `status` + `closedAt` if the target stage
   * is a WON/LOST terminal.
   */
  async moveCard(
    cardId: string,
    organizationId: string,
    dto: MoveCardDto,
  ) {
    const card = await this.prisma.card.findUnique({ where: { id: cardId } });
    if (!card || card.organizationId !== organizationId) {
      throw new NotFoundException('Card not found');
    }
    const targetStage = await this.prisma.pipelineStage.findUnique({
      where: { id: dto.toStageId },
    });
    if (!targetStage || targetStage.pipelineId !== card.pipelineId) {
      throw new BadRequestException('toStageId fora desse pipeline');
    }

    const fromStageId = card.stageId;
    const fromIndex = card.order;
    const sameStage = fromStageId === dto.toStageId;

    let newStatus: CardStatus = card.status;
    let newClosedAt = card.closedAt;
    let newClosedReason = card.closedReason;
    if (targetStage.type === 'WON') {
      newStatus = CardStatus.WON;
      newClosedAt = newClosedAt ?? new Date();
      newClosedReason = null;
    } else if (targetStage.type === 'LOST') {
      newStatus = CardStatus.LOST;
      newClosedAt = newClosedAt ?? new Date();
      newClosedReason = dto.closedReason?.trim() || newClosedReason || null;
    } else {
      newStatus = CardStatus.OPEN;
      newClosedAt = null;
      newClosedReason = null;
    }

    await this.prisma.$transaction(async (tx) => {
      if (sameStage) {
        // Reorder within the same column.
        if (fromIndex === dto.toIndex) return;
        if (fromIndex < dto.toIndex) {
          await tx.card.updateMany({
            where: {
              pipelineId: card.pipelineId,
              stageId: fromStageId,
              order: { gt: fromIndex, lte: dto.toIndex },
            },
            data: { order: { decrement: 1 } },
          });
        } else {
          await tx.card.updateMany({
            where: {
              pipelineId: card.pipelineId,
              stageId: fromStageId,
              order: { gte: dto.toIndex, lt: fromIndex },
            },
            data: { order: { increment: 1 } },
          });
        }
      } else {
        // Close the gap in source stage.
        await tx.card.updateMany({
          where: {
            pipelineId: card.pipelineId,
            stageId: fromStageId,
            order: { gt: fromIndex },
          },
          data: { order: { decrement: 1 } },
        });
        // Open a slot in target stage.
        await tx.card.updateMany({
          where: {
            pipelineId: card.pipelineId,
            stageId: dto.toStageId,
            order: { gte: dto.toIndex },
          },
          data: { order: { increment: 1 } },
        });
      }

      await tx.card.update({
        where: { id: cardId },
        data: {
          stageId: dto.toStageId,
          order: dto.toIndex,
          status: newStatus,
          closedAt: newClosedAt,
          closedReason: newClosedReason,
        },
      });
    });

    this.realtime.emitToOrg(organizationId, 'card:moved', {
      cardId,
      pipelineId: card.pipelineId,
      fromStageId,
      toStageId: dto.toStageId,
      toIndex: dto.toIndex,
      status: newStatus,
    });

    // Auto-dispara Salesbots cujo gatilho é "ao entrar nesta etapa" (paridade
    // com o "executar robô ao mover para a etapa" do Kommo). Só quando o card
    // realmente mudou de etapa e está vinculado a uma conversa.
    if (!sameStage && card.conversationId) {
      void this.cadences.onStageEntered(
        organizationId,
        card.conversationId,
        dto.toStageId,
      );
    }

    return this.prisma.card.findUnique({
      where: { id: cardId },
      include: {
        contact: { select: { id: true, name: true, phone: true, avatarUrl: true } },
        assignedTo: { select: { id: true, name: true, avatarUrl: true } },
      },
    });
  }

  // ─── Roteamento origem → funil/etapa ───────────

  private normalizeStr(s: unknown): string {
    return String(s ?? '').trim().toLowerCase();
  }

  /** Deriva o TIPO de origem a partir do canal/lead source. */
  private originTypeFrom(
    channelType?: string | null,
    leadSource?: string | null,
  ): string | null {
    const ls = this.normalizeStr(leadSource);
    if (ls.includes('landing') || ls === 'lp') return 'LANDING_PAGE';
    if (ls.includes('leadads') || ls.includes('facebook_lead'))
      return 'FACEBOOK_LEADADS';
    const ct = String(channelType ?? '').toUpperCase();
    if (ct.includes('WHATSAPP') || ct.includes('ZAPPFY') || ct.includes('ZAPI'))
      return 'WHATSAPP';
    if (ct.includes('INSTAGRAM')) return 'INSTAGRAM';
    if (ct.includes('TELEGRAM')) return 'TELEGRAM';
    if (ct.includes('MERCADO')) return 'MERCADO_LIVRE';
    if (ct.includes('SHOPEE')) return 'SHOPEE';
    return null;
  }

  /** Lê a config de roteamento salva em organization.settings.leadRouting. */
  async getLeadRouting(organizationId: string): Promise<LeadRouting> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    const settings = (org?.settings ?? {}) as any;
    const r = settings.leadRouting ?? {};
    return {
      byType: r.byType ?? {},
      exceptions: Array.isArray(r.exceptions) ? r.exceptions : [],
    };
  }

  /**
   * Resolve o funil/etapa destino a partir da origem do lead. Ordem:
   * 1) exceções (canal específico / página Lead Ads / utm_source)
   * 2) regra por TIPO de origem
   * Valida que o pipeline existe, não está arquivado e a etapa é dele.
   * Retorna null se não houver regra válida (→ o chamador usa o padrão).
   */
  private async resolveByRouting(
    organizationId: string,
    ctx: RoutingCtx,
  ): Promise<{ pipelineId: string; stageId: string } | null> {
    const routing = await this.getLeadRouting(organizationId);

    let channelType = ctx.channelType ?? null;
    if (!channelType && ctx.channelId) {
      const ch = await this.prisma.channel.findUnique({
        where: { id: ctx.channelId },
        select: { type: true },
      });
      channelType = ch?.type ?? null;
    }

    let target: RoutingTarget | undefined;
    for (const ex of routing.exceptions) {
      if (!ex?.pipelineId) continue;
      if (ex.kind === 'CHANNEL' && ctx.channelId && ex.value === ctx.channelId) {
        target = ex;
        break;
      }
      if (
        ex.kind === 'LEADADS_PAGE' &&
        ctx.leadAdsPageId &&
        ex.value === ctx.leadAdsPageId
      ) {
        target = ex;
        break;
      }
      if (
        ex.kind === 'UTM_SOURCE' &&
        ctx.utmSource &&
        this.normalizeStr(ex.value) === this.normalizeStr(ctx.utmSource)
      ) {
        target = ex;
        break;
      }
    }

    if (!target) {
      const ot = this.originTypeFrom(channelType, ctx.leadSource);
      if (ot && routing.byType[ot]?.pipelineId) target = routing.byType[ot];
    }
    if (!target?.pipelineId) return null;

    const pipeline = await this.prisma.pipeline.findFirst({
      where: { id: target.pipelineId, organizationId, archived: false },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    if (!pipeline || pipeline.stages.length === 0) return null;
    const stage =
      (target.stageId &&
        pipeline.stages.find((s) => s.id === target!.stageId)) ||
      pipeline.stages[0];
    return { pipelineId: pipeline.id, stageId: stage.id };
  }

  /** Alvo de entrada: roteamento por origem → senão pipeline padrão (1ª etapa). */
  private async pickEntryTarget(
    organizationId: string,
    ctx?: RoutingCtx,
  ): Promise<{ pipelineId: string; stageId: string } | null> {
    if (ctx) {
      const routed = await this.resolveByRouting(organizationId, ctx);
      if (routed) return routed;
    }
    const pipeline = await this.prisma.pipeline.findFirst({
      where: { organizationId, archived: false },
      orderBy: [{ isDefault: 'desc' }, { order: 'asc' }],
      include: { stages: { orderBy: { order: 'asc' }, take: 1 } },
    });
    if (!pipeline || pipeline.stages.length === 0) return null;
    return { pipelineId: pipeline.id, stageId: pipeline.stages[0].id };
  }

  /**
   * Cria um card na etapa de entrada para um CONTATO (sem conversa) — usado
   * por fontes como Facebook Leads Ads e Landing Page. Roteia por origem
   * (ctx) quando configurado; senão cai no pipeline padrão. Dedupe por card
   * aberto do contato.
   */
  async createEntryCardForContact(
    organizationId: string,
    contactId: string,
    title: string,
    metadata?: Record<string, any>,
    ctx?: RoutingCtx,
  ) {
    const contactCard = await this.prisma.card.findFirst({
      where: { organizationId, contactId, status: 'OPEN' },
      select: { id: true },
    });
    if (contactCard) return null;

    const target = await this.pickEntryTarget(organizationId, ctx);
    if (!target) return null;
    const count = await this.prisma.card.count({
      where: { pipelineId: target.pipelineId, stageId: target.stageId },
    });
    const card = await this.prisma.card.create({
      data: {
        organizationId,
        pipelineId: target.pipelineId,
        stageId: target.stageId,
        title: title?.trim() || 'Novo lead',
        contactId,
        order: count,
        metadata: (metadata ?? {}) as any,
      },
    });
    this.realtime.emitToOrg(organizationId, 'card:created', { card });
    return card;
  }

  /**
   * Cria automaticamente um card na ETAPA DE ENTRADA (1ª etapa do pipeline
   * padrão) para uma conversa nova — paridade com o "origem → cria lead" do
   * Kommo. Idempotente: não duplica se a conversa já tem card. Best-effort.
   */
  async ensureEntryCard(
    organizationId: string,
    conversationId: string,
    contactId: string | null,
    title: string,
    ctx?: RoutingCtx,
  ) {
    const existing = await this.prisma.card.findFirst({
      where: { conversationId },
      select: { id: true },
    });
    if (existing) return null;

    // Controle de duplicatas: se o contato já tem um card ABERTO na org, não
    // cria outro lead (paridade com o "controle de duplicatas" do Kommo).
    if (contactId) {
      const contactCard = await this.prisma.card.findFirst({
        where: { organizationId, contactId, status: 'OPEN' },
        select: { id: true },
      });
      if (contactCard) return null;
    }

    // Roteia por origem (canal) quando configurado; senão pipeline padrão.
    const target = await this.pickEntryTarget(organizationId, ctx);
    if (!target) return null;

    const count = await this.prisma.card.count({
      where: { pipelineId: target.pipelineId, stageId: target.stageId },
    });
    const card = await this.prisma.card.create({
      data: {
        organizationId,
        pipelineId: target.pipelineId,
        stageId: target.stageId,
        title: title?.trim() || 'Novo lead',
        contactId: contactId ?? null,
        conversationId,
        order: count,
      },
    });
    this.realtime.emitToOrg(organizationId, 'card:created', { card });
    return card;
  }

  /**
   * Lista todos os cards (pipelines) em que uma conversa está. Usado pela
   * UI da inbox pra mostrar/editar/remover a conversa de pipelines direto
   * do header da conversa (sem precisar abrir o kanban).
   */
  async listCardsByConversation(
    conversationId: string,
    organizationId: string,
  ) {
    return this.prisma.card.findMany({
      where: { conversationId, organizationId },
      orderBy: { createdAt: 'asc' },
      include: {
        pipeline: {
          select: {
            id: true,
            name: true,
            color: true,
            icon: true,
            archived: true,
          },
        },
        stage: {
          select: { id: true, name: true, color: true, type: true, order: true },
        },
      },
    });
  }

  /**
   * Card único com o CONTATO COMPLETO para o painel de enriquecimento do
   * lead (data, fonte, e-mail, tracking/UTM, tags). Diferente do board (que
   * traz só id/name/phone/avatar por performance), aqui hidratamos email,
   * notes, metadata (onde vive tracking) e as tags do contato.
   *
   * Exemplo de saída (resumido):
   * {
   *   id, title, status, createdAt, metadata: { source, tracking, raw },
   *   stage: { id, name, type }, conversation: { channel: { type } },
   *   contact: { id, name, phone, email, metadata: { tracking: {...} },
   *             tags: [{ id, name, color }] }
   * }
   */
  async getCard(cardId: string, organizationId: string) {
    const card = await this.prisma.card.findUnique({
      where: { id: cardId },
      include: {
        contact: {
          select: {
            id: true,
            name: true,
            phone: true,
            email: true,
            avatarUrl: true,
            notes: true,
            metadata: true,
            createdAt: true,
            tags: { select: { tag: { select: { id: true, name: true, color: true } } } },
          },
        },
        assignedTo: { select: { id: true, name: true, avatarUrl: true } },
        stage: { select: { id: true, name: true, type: true, color: true } },
        conversation: {
          select: {
            id: true,
            channelId: true,
            channel: { select: { id: true, type: true, name: true } },
          },
        },
      },
    });
    if (!card || card.organizationId !== organizationId) {
      throw new NotFoundException('Card not found');
    }
    // Achata as tags (join table) pra facilitar a vida do frontend.
    const tags = (card.contact?.tags ?? []).map((t) => t.tag);
    return {
      ...card,
      contact: card.contact ? { ...card.contact, tags } : null,
    };
  }

  /** Salva a config de roteamento (valida pipelines/etapas da org). */
  async saveRouting(organizationId: string, dto: LeadRouting) {
    const byType = dto?.byType ?? {};
    const exceptions = Array.isArray(dto?.exceptions) ? dto.exceptions : [];

    const pipelineIds = new Set<string>();
    for (const t of Object.values(byType)) if (t?.pipelineId) pipelineIds.add(t.pipelineId);
    for (const e of exceptions) if (e?.pipelineId) pipelineIds.add(e.pipelineId);

    if (pipelineIds.size > 0) {
      const found = await this.prisma.pipeline.findMany({
        where: { id: { in: Array.from(pipelineIds) }, organizationId },
        include: { stages: { select: { id: true } } },
      });
      const map = new Map(found.map((p) => [p.id, new Set(p.stages.map((s) => s.id))]));
      const check = (t?: RoutingTarget) => {
        if (!t?.pipelineId) return;
        if (!map.has(t.pipelineId))
          throw new BadRequestException('Funil inválido no roteamento');
        if (t.stageId && !map.get(t.pipelineId)!.has(t.stageId))
          throw new BadRequestException('Etapa inválida pro funil escolhido');
      };
      for (const t of Object.values(byType)) check(t);
      for (const e of exceptions) check(e);
    }

    const clean: LeadRouting = {
      byType,
      exceptions: exceptions
        .filter((e) => e?.kind && e?.value && e?.pipelineId)
        .map((e, i) => ({
          id: e.id ?? `ex_${Date.now()}_${i}`,
          kind: e.kind,
          value: e.value,
          pipelineId: e.pipelineId,
          stageId: e.stageId,
          label: e.label,
        })),
    };

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { settings: true },
    });
    const settings = { ...((org?.settings as any) ?? {}), leadRouting: clean };
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { settings: settings as any },
    });
    return clean;
  }

  /** Opções para a UI de roteamento: canais e páginas Lead Ads (exceções). */
  async getRoutingOptions(organizationId: string) {
    const [channels, leadAdsPages] = await this.prisma.$transaction([
      this.prisma.channel.findMany({
        where: { organizationId, deletedAt: null },
        select: { id: true, type: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.leadAdsPage.findMany({
        where: { organizationId },
        select: { pageId: true, pageName: true },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return { types: ORIGIN_TYPES, channels, leadAdsPages };
  }

  // ─── helpers ───────────────────────────────────

  private async assertPipeline(id: string, organizationId: string) {
    const p = await this.prisma.pipeline.findUnique({ where: { id } });
    if (!p) throw new NotFoundException('Pipeline not found');
    if (p.organizationId !== organizationId) throw new ForbiddenException();
    return p;
  }
}
