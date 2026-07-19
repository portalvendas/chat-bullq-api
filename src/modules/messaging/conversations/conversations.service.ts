import {
  Injectable,
  Logger,
  NotFoundException,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Conversation, ConversationStatus, ChannelType } from '@prisma/client';
import { ConversationsRepository, InboxFilters } from './conversations.repository';
import { ConversationFsmService } from './conversation-fsm.service';
import { UpdateConversationDto } from './dto/update-conversation.dto';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { PrismaService } from '../../../database/prisma.service';
import { ChannelAdapterRegistry } from '../../channel-hub/channel-adapter.registry';
import { HistoryImportService } from '../pipeline/history-import.service';
import {
  ChannelAccess,
  ChannelAccessService,
} from '../../iam/channel-access/channel-access.service';
import { AgentRouterService } from '../../ai-agents/router/agent-router.service';
import { AiAgentRunnerService } from '../../ai-agents/runner/agent-runner.service';

const SYNC_MESSAGE_PAGE_SIZE = 50;
const SYNC_MAX_PAGES = 4;

@Injectable()
export class ConversationsService {
  private readonly logger = new Logger(ConversationsService.name);

  constructor(
    private readonly repository: ConversationsRepository,
    private readonly fsm: ConversationFsmService,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly prisma: PrismaService,
    private readonly adapterRegistry: ChannelAdapterRegistry,
    private readonly historyImporter: HistoryImportService,
    private readonly channelAccess: ChannelAccessService,
    private readonly agentRouter: AgentRouterService,
    private readonly agentRunner: AiAgentRunnerService,
  ) {}

  /**
   * Contagem de conversas "SEM RESPOSTA" por canal + bucket geral, pro badge
   * de alerta na árvore da inbox. Definição: a ÚLTIMA mensagem da conversa é
   * INBOUND (o cliente falou por último e ainda não respondemos) — cobre o
   * caso do modo revisão (resposta gerada mas ainda não aprovada/enviada).
   *
   * Performance: usa o índice (conversation_id, created_at) via LATERAL pra
   * pegar só a última mensagem de cada conversa aberta. Ignora CLOSED,
   * arquivadas e deletadas.
   */
  async getUnansweredCounts(organizationId: string): Promise<{
    general: number;
    byChannelId: Record<string, number>;
  }> {
    const rows = await this.prisma.$queryRaw<
      Array<{ channelId: string; count: number }>
    >`
      SELECT c.channel_id AS "channelId", COUNT(*)::int AS count
      FROM conversations c
      JOIN LATERAL (
        SELECT m.direction
        FROM messages m
        WHERE m.conversation_id = c.id
        ORDER BY m.created_at DESC
        LIMIT 1
      ) lm ON true
      WHERE c.organization_id = ${organizationId}
        AND c.deleted_at IS NULL
        AND c.is_archived = false
        AND c.status <> 'CLOSED'::"ConversationStatus"
        AND lm.direction = 'INBOUND'::"MessageDirection"
      GROUP BY c.channel_id
    `;

    const byChannelId: Record<string, number> = {};
    for (const r of rows) byChannelId[r.channelId] = Number(r.count);

    // "Geral" = conversas de canais NÃO-marketplace (WhatsApp/Instagram/etc).
    const ids = Object.keys(byChannelId);
    let general = 0;
    if (ids.length) {
      const MARKETPLACE_TYPES: ChannelType[] = [
        ChannelType.MERCADO_LIVRE,
        ChannelType.SHOPEE,
      ];
      const channels = await this.prisma.channel.findMany({
        where: { organizationId, id: { in: ids } },
        select: { id: true, type: true },
      });
      for (const ch of channels) {
        if (!MARKETPLACE_TYPES.includes(ch.type)) {
          general += byChannelId[ch.id] ?? 0;
        }
      }
    }

    return { general, byChannelId };
  }

  private broadcastUpdate(conversation: Conversation | null): void {
    if (!conversation) return;
    this.realtimeGateway.emitToChannel(
      conversation.channelId,
      'conversation:updated',
      { conversation },
    );
    this.realtimeGateway.emitToConversation(
      conversation.id,
      'conversation:updated',
      { conversation },
    );
  }

  async findInbox(
    organizationId: string,
    filters: {
      status?: string;
      channelId?: string;
      channelIds?: string[];
      conversationIds?: string[];
      kind?: 'INDIVIDUAL' | 'GROUP';
      tagIds?: string[];
      assignedToId?: string;
      search?: string;
      archived?: 'exclude' | 'only' | 'any';
      unreadOnly?: boolean;
      stuckOnly?: boolean;
      /** Separa inbox de conversa (WhatsApp/Instagram) do marketplace (ML,
       *  pergunta→resposta). Resolve pra channelIds do tipo correspondente. */
      category?: 'conversation' | 'marketplace';
    },
    page: number,
    limit: number,
    access: ChannelAccess = 'ALL',
    currentUserId?: string,
  ) {
    const validStatuses = new Set(Object.values(ConversationStatus));
    const parsedStatuses = filters.status
      ?.split(',')
      .map((s) => s.trim() as ConversationStatus)
      .filter((s) => validStatuses.has(s));

    // Resolve `category` → conjunto de channelIds. Marketplace = ML (e futuros
    // marketplaces); conversa = todo o resto. Reusa o filtro channelIds.
    let channelIds = filters.channelIds;
    let channelId = filters.channelId;
    if (filters.category) {
      const MARKETPLACE_TYPES = [ChannelType.MERCADO_LIVRE, ChannelType.SHOPEE];
      const chans = await this.prisma.channel.findMany({
        where: {
          organizationId,
          deletedAt: null,
          type:
            filters.category === 'marketplace'
              ? { in: MARKETPLACE_TYPES }
              : { notIn: MARKETPLACE_TYPES },
        },
        select: { id: true },
      });
      let ids = chans.map((c) => c.id);
      if (channelId) ids = ids.filter((i) => i === channelId);
      // Lista vazia = nenhum canal daquela categoria → não retorna nada
      // (sentinela impossível em vez de "sem filtro").
      channelIds = ids.length ? ids : ['__none__'];
      channelId = undefined;
    }

    const inboxFilters: InboxFilters = {
      organizationId,
      status: parsedStatuses?.length ? parsedStatuses : undefined,
      channelId,
      channelIds,
      conversationIds: filters.conversationIds,
      kind: filters.kind,
      tagIds: filters.tagIds,
      assignedToId: filters.assignedToId,
      search: filters.search,
      accessibleChannelIds: access === 'ALL' ? undefined : [...access],
      archived: filters.archived,
      unreadOnly: filters.unreadOnly,
      stuckOnly: filters.stuckOnly,
    };

    const skip = (page - 1) * limit;
    const { conversations, total } = await this.repository.findInbox(
      inboxFilters,
      skip,
      limit,
      currentUserId,
    );

    return {
      conversations,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, organizationId: string, access: ChannelAccess = 'ALL') {
    const conversation = await this.repository.findById(id);
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.organizationId !== organizationId) {
      throw new ForbiddenException();
    }
    this.channelAccess.assertChannelAccess(access, conversation.channelId);
    return conversation;
  }

  async update(
    id: string,
    organizationId: string,
    dto: UpdateConversationDto,
    actorId: string,
    access: ChannelAccess = 'ALL',
  ) {
    const conversation = await this.findOne(id, organizationId, access);

    if (dto.assignedToId) {
      await this.fsm.assign(id, dto.assignedToId, actorId);
    }

    if (dto.status && dto.status !== conversation.status) {
      await this.fsm.transition(id, dto.status, actorId);
    }

    if (dto.departmentId) {
      await this.repository.update(id, { department: { connect: { id: dto.departmentId } } });
    }

    if (dto.subject !== undefined) {
      const trimmed = dto.subject.trim();
      await this.repository.update(id, {
        subject: trimmed.length > 0 ? trimmed : null,
      });
    }

    // Override do modo revisão por conversa (null=segue org, true/false=força).
    if (dto.aiReviewMode !== undefined) {
      await this.repository.update(id, { aiReviewMode: dto.aiReviewMode });
    }

    const updated = await this.repository.findById(id);
    this.broadcastUpdate(updated as Conversation | null);
    return updated;
  }

  async toggleAi(
    id: string,
    organizationId: string,
    enabled: boolean | null,
    actorId: string,
    access: ChannelAccess = 'ALL',
  ) {
    await this.findOne(id, organizationId, access);

    // Tri-state:
    //   null  = limpa override, conversa volta a seguir regras globais
    //   true  = força ON (sobrepõe kill switch e horário)
    //   false = força OFF
    const updated = await this.prisma.conversation.update({
      where: { id },
      data:
        enabled === null
          ? {
              aiEnabled: null,
              aiDisabledBy: null,
              aiDisabledAt: null,
            }
          : enabled === true
            ? {
                aiEnabled: true,
                aiDisabledBy: null,
                aiDisabledAt: null,
              }
            : {
                aiEnabled: false,
                aiDisabledBy: actorId,
                aiDisabledAt: new Date(),
                activeAgentId: null,
              },
    });

    await this.prisma.conversationAuditLog.create({
      data: {
        conversationId: id,
        actorId,
        action:
          enabled === null
            ? 'AI_OVERRIDE_CLEARED'
            : enabled
              ? 'AI_FORCED_ON'
              : 'AI_FORCED_OFF',
        metadata: {},
      },
    });
    this.realtimeGateway.emitToConversation(id, 'conversation:ai-toggle', {
      conversationId: id,
      aiEnabled: enabled,
      actorId,
    });
    return updated;
  }

  /**
   * Manually trigger the AI agent to engage with this conversation right now.
   * Reads the latest inbound (or any latest message if no inbound) as the
   * trigger, calls the runner, and returns whatever final action the agent
   * decided. Skipped silently if the router rejects (paused, no agent, etc).
   */
  async engageAi(
    id: string,
    organizationId: string,
    actorId: string,
    access: ChannelAccess = 'ALL',
  ): Promise<{ engaged: boolean; reason?: string }> {
    const conversation = await this.findOne(id, organizationId, access);

    const decision = await this.agentRouter.shouldHandle(
      conversation as Conversation,
    );
    if (!decision.handle) {
      this.logger.log(
        `engageAi skipped for conv ${id}: ${decision.reason} (actor=${actorId})`,
      );
      return { engaged: false, reason: decision.reason };
    }

    // Pick the most recent inbound as the trigger so the agent has something
    // concrete to react to. Fall back to the latest message of any direction
    // (covers the case where the conversation was opened by the human).
    const triggerMessage =
      (await this.prisma.message.findFirst({
        where: { conversationId: id, direction: 'INBOUND' },
        orderBy: { createdAt: 'desc' },
      })) ??
      (await this.prisma.message.findFirst({
        where: { conversationId: id },
        orderBy: { createdAt: 'desc' },
      }));

    if (!triggerMessage) {
      return { engaged: false, reason: 'no-messages' };
    }

    await this.prisma.conversationAuditLog.create({
      data: {
        conversationId: id,
        actorId,
        action: 'AI_ENGAGED_MANUALLY',
        metadata: { triggerMessageId: triggerMessage.id },
      },
    });

    // Runner is async — kick it off in the background. The response payload
    // (new outbound message) will arrive via realtime + the run record will
    // appear in /ai-agents stats. Frontend can refetch right after the call.
    this.agentRunner
      .run({ conversation: conversation as Conversation, triggerMessage })
      .catch((err) =>
        this.logger.error(
          `engageAi run failed for conv ${id}: ${err?.message ?? err}`,
        ),
      );

    return { engaged: true };
  }

  /**
   * Regenera a resposta pendente com uma INFORMAÇÃO COMPLEMENTAR do operador
   * (ex: "Material é MDF"). O complemento:
   *  1. vira uma nota AUTORITATIVA na base de conhecimento (memória p/ futuras
   *     respostas — inclusive de outros compradores do mesmo anúncio);
   *  2. expira o(s) pending action(s) atual(is) da conversa (some da tela);
   *  3. re-roda o agente com a MESMA pergunta — agora com o complemento já no
   *     prompt — produzindo um novo pending action pra aprovar.
   */
  async regenerateAnswer(
    id: string,
    organizationId: string,
    complement: string,
    actorId: string,
    access: ChannelAccess = 'ALL',
    scope: 'item' | 'store' = 'item',
  ): Promise<{ ok: boolean }> {
    const trimmed = (complement ?? '').trim();
    if (!trimmed) {
      throw new BadRequestException('Informe a informação complementar');
    }
    const conversation = await this.findOne(id, organizationId, access);

    const triggerMessage = await this.prisma.message.findFirst({
      where: { conversationId: id, direction: 'INBOUND' },
      orderBy: { createdAt: 'desc' },
    });
    if (!triggerMessage) {
      throw new BadRequestException('Sem pergunta do cliente para regerar');
    }

    // Escopo da nota: 'store' = fato geral da loja (itemId null); 'item' =
    // específico do anúncio desta pergunta (marketplace). Sem anúncio detectado,
    // 'item' cai naturalmente em null (vira geral).
    const content = (triggerMessage.content ?? {}) as Record<string, any>;
    const detectedItemId = content?.mlItem?.id
      ? String(content.mlItem.id)
      : null;
    const itemId = scope === 'store' ? null : detectedItemId;

    // 1) Memória: salva o complemento como fato confirmado.
    await this.prisma.agentKnowledgeNote.create({
      data: {
        organizationId,
        itemId,
        text: trimmed,
        sourceQuestion: typeof content.text === 'string' ? content.text : null,
        createdById: actorId,
      },
    });

    // 2) Expira os pending pendentes desta conversa (removem-se da tela).
    await this.prisma.aiPendingAction.updateMany({
      where: { conversationId: id, status: 'PENDING' },
      data: { status: 'EXPIRED' },
    });

    // 3) Re-roda o agente com a mesma pergunta (complemento já no prompt).
    this.agentRunner
      .run({ conversation: conversation as Conversation, triggerMessage })
      .catch((err) =>
        this.logger.error(
          `regenerateAnswer run failed for conv ${id}: ${err?.message ?? err}`,
        ),
      );

    return { ok: true };
  }

  /**
   * Manually pin a specific AI agent to this conversation and immediately
   * engage it. Use case: human says "vou te passar pra Lívia" via manual
   * message — the system can't infer that intent from text, so the operator
   * picks the agent in the UI and we (a) flip activeAgentId, (b) clear any
   * paused state (force AI on for this conversation), (c) fire the runner.
   */
  async setActiveAgent(
    id: string,
    organizationId: string,
    agentId: string,
    actorId: string,
    access: ChannelAccess = 'ALL',
  ): Promise<{ engaged: boolean; reason?: string; agentName?: string }> {
    const conversation = await this.findOne(id, organizationId, access);

    const agent = await this.prisma.aiAgent.findFirst({
      where: { id: agentId, organizationId, isActive: true, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!agent) {
      throw new NotFoundException('Agent not found or not active in this org');
    }

    // Pin agent + force AI on for this conversation (override any pause).
    const updated = await this.prisma.conversation.update({
      where: { id },
      data: {
        activeAgentId: agentId,
        aiEnabled: true,
        aiDisabledBy: null,
        aiDisabledAt: null,
      },
    });

    await this.prisma.conversationAuditLog.create({
      data: {
        conversationId: id,
        actorId,
        action: 'AI_AGENT_SET',
        fromValue: conversation.activeAgentId,
        toValue: agentId,
        metadata: { agentName: agent.name },
      },
    });

    this.broadcastUpdate(updated as Conversation);
    this.realtimeGateway.emitToConversation(id, 'conversation:ai-toggle', {
      conversationId: id,
      aiEnabled: true,
      activeAgentId: agentId,
      reason: 'agent-pinned',
    });

    // Pick latest inbound (preferred) or fallback to any latest message.
    const triggerMessage =
      (await this.prisma.message.findFirst({
        where: { conversationId: id, direction: 'INBOUND' },
        orderBy: { createdAt: 'desc' },
      })) ??
      (await this.prisma.message.findFirst({
        where: { conversationId: id },
        orderBy: { createdAt: 'desc' },
      }));

    if (!triggerMessage) {
      return {
        engaged: false,
        reason: 'no-messages',
        agentName: agent.name,
      };
    }

    this.agentRunner
      .run({
        conversation: updated as Conversation,
        triggerMessage,
      })
      .catch((err) =>
        this.logger.error(
          `setActiveAgent run failed for conv ${id}: ${err?.message ?? err}`,
        ),
      );

    return { engaged: true, agentName: agent.name };
  }

  async close(
    id: string,
    organizationId: string,
    actorId: string,
    access: ChannelAccess = 'ALL',
  ) {
    await this.findOne(id, organizationId, access);
    await this.fsm.transition(id, ConversationStatus.CLOSED, actorId);
    const updated = await this.repository.findById(id);
    this.broadcastUpdate(updated as Conversation | null);
    return updated;
  }

  async reopen(
    id: string,
    organizationId: string,
    actorId: string,
    access: ChannelAccess = 'ALL',
  ) {
    const conversation = await this.findOne(id, organizationId, access);
    const target = conversation.assignedToId
      ? ConversationStatus.OPEN
      : ConversationStatus.PENDING;
    await this.fsm.transition(id, target, actorId);
    const updated = await this.repository.findById(id);
    this.broadcastUpdate(updated as Conversation | null);
    return updated;
  }

  /**
   * Hard delete — apaga a conversa de verdade. Cascade nas FKs (messages,
   * tags, audit logs, AI runs, reads, internal notes, rating, cards) cuida
   * dos dependentes. Operação irreversível: exige confirmação digitando o
   * nome ou telefone exato do contato.
   */
  async hardDelete(
    id: string,
    organizationId: string,
    access: ChannelAccess = 'ALL',
    confirm?: string,
  ) {
    const conversation = await this.findOne(id, organizationId, access);
    const expectedName = (conversation as any).contact?.name?.trim();
    const expectedPhone = (conversation as any).contact?.phone?.trim();
    const provided = (confirm ?? '').trim();
    if (!provided) {
      throw new BadRequestException(
        'Confirmação obrigatória: passe ?confirm=<nome ou telefone exato do contato>.',
      );
    }
    if (provided !== expectedName && provided !== expectedPhone) {
      throw new BadRequestException(
        'Confirmação não confere com o nome ou telefone do contato — apagamento abortado.',
      );
    }

    // FKs estão com onDelete: Cascade nos relacionados (messages,
    // conversation_tags, ai_agent_runs, conversation_reads, etc.) então
    // basta apagar a conversa que o resto cai junto.
    await this.prisma.conversation.delete({ where: { id } });

    this.realtimeGateway.emitToChannel(
      conversation.channelId,
      'conversation:deleted',
      { conversationId: id },
    );
    return { ok: true, id };
  }

  async setArchived(
    id: string,
    organizationId: string,
    archived: boolean,
    actorId: string,
    access: ChannelAccess = 'ALL',
  ) {
    await this.findOne(id, organizationId, access);
    const updated = await this.prisma.conversation.update({
      where: { id },
      data: archived
        ? { isArchived: true, archivedAt: new Date(), archivedById: actorId }
        : { isArchived: false, archivedAt: null, archivedById: null },
    });

    await this.prisma.conversationAuditLog.create({
      data: {
        conversationId: id,
        actorId,
        action: archived ? 'CONVERSATION_ARCHIVED' : 'CONVERSATION_UNARCHIVED',
        metadata: {},
      },
    });

    this.broadcastUpdate(updated as Conversation);
    return updated;
  }

  async assignToMe(
    id: string,
    organizationId: string,
    userId: string,
    access: ChannelAccess = 'ALL',
  ) {
    await this.findOne(id, organizationId, access);
    await this.fsm.assign(id, userId, userId);
    const updated = await this.repository.findById(id);
    this.broadcastUpdate(updated as Conversation | null);
    return updated;
  }

  async getStatusCounts(organizationId: string, access: ChannelAccess = 'ALL') {
    const accessibleIds = access === 'ALL' ? undefined : [...access];
    return this.repository.countByStatus(organizationId, accessibleIds);
  }

  /**
   * Marks a conversation as read for the current user. Upserts the
   * ConversationRead row with lastReadAt = now and emits a realtime
   * `conversation:read` event so any open client (other tab, mobile)
   * zeros the badge in real time.
   */
  async markAsRead(
    conversationId: string,
    organizationId: string,
    userId: string,
    access: ChannelAccess = 'ALL',
    lastReadMessageId?: string,
  ) {
    await this.findOne(conversationId, organizationId, access);
    const read = await this.repository.markAsRead(
      userId,
      conversationId,
      lastReadMessageId,
    );

    this.realtimeGateway.emitToUser(userId, 'conversation:read', {
      conversationId,
      userId,
      lastReadAt: read.lastReadAt,
    });

    return { ok: true, lastReadAt: read.lastReadAt };
  }

  /**
   * Per-user "mark as unread". Pushes lastReadAt before the latest inbound so
   * the conversation re-surfaces as unread for THIS user only. Other users'
   * read state is untouched.
   */
  async markAsUnread(
    conversationId: string,
    organizationId: string,
    userId: string,
    access: ChannelAccess = 'ALL',
  ) {
    await this.findOne(conversationId, organizationId, access);
    const result = await this.repository.markAsUnread(userId, conversationId);

    this.realtimeGateway.emitToUser(userId, 'conversation:unread', {
      conversationId,
      userId,
      unreadCount: result.unreadCount,
    });

    return { ok: true, unreadCount: result.unreadCount };
  }

  /**
   * On-demand sync of a single conversation: pulls the latest messages from
   * the channel provider (e.g. Zappfy) and merges them with what we already
   * have locally. The webhook covers the steady state — this is the recovery
   * path for when an event was missed (provider downtime, webhook hiccup,
   * channel reconnected, etc.).
   */
  async syncMessages(id: string, organizationId: string, access: ChannelAccess = 'ALL') {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id },
      include: {
        channel: true,
        contact: {
          include: {
            channels: true,
          },
        },
      },
    });

    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.organizationId !== organizationId) {
      throw new ForbiddenException();
    }
    this.channelAccess.assertChannelAccess(access, conversation.channelId);

    const adapter = this.adapterRegistry.getHistorySync(conversation.channel.type);
    if (!adapter) {
      throw new BadRequestException(
        `Channel type ${conversation.channel.type} does not support sync`,
      );
    }

    const externalId = this.resolveExternalConversationId(conversation);
    if (!externalId) {
      throw new BadRequestException(
        'Cannot sync: conversation has no external chat id',
      );
    }

    let cursor: string | undefined;
    let imported = 0;
    let fetched = 0;
    let pages = 0;

    try {
      do {
        const result = await adapter.fetchMessages(
          conversation.channel,
          externalId,
          {},
          cursor,
          SYNC_MESSAGE_PAGE_SIZE,
        );
        fetched += result.messages.length;
        if (result.messages.length === 0) break;

        const res = await this.historyImporter.importMessages(
          conversation.channel,
          conversation.id,
          result.messages,
        );
        imported += res.imported;
        cursor = result.nextCursor;
        pages++;

        // Stop early once we hit a page where everything was already known —
        // the provider returns newest-first, so older pages can only be older
        // than what we already imported.
        if (res.imported === 0) break;
      } while (cursor && pages < SYNC_MAX_PAGES);
    } catch (err: any) {
      this.logger.error(
        `Failed to sync conversation ${id}: ${err.message}`,
        err.stack,
      );
      throw new BadRequestException(
        `Sync failed: ${err.response?.data?.message || err.message}`,
      );
    }

    if (imported > 0) {
      await this.historyImporter.notifyConversationImported(
        organizationId,
        conversation.id,
      );
    }

    this.logger.log(
      `Conversation ${id} synced: ${imported} new, ${fetched - imported} already known`,
    );

    return {
      imported,
      fetched,
      syncedAt: new Date().toISOString(),
    };
  }

  private resolveExternalConversationId(conversation: {
    channelId: string;
    metadata: any;
    contact: { channels: { channelId: string; externalId: string }[] };
  }): string | null {
    const fromMetadata =
      conversation.metadata &&
      typeof conversation.metadata === 'object' &&
      'externalConversationId' in conversation.metadata
        ? String((conversation.metadata as any).externalConversationId)
        : null;
    if (fromMetadata) return fromMetadata;

    const contactChannel = conversation.contact.channels.find(
      (c) => c.channelId === conversation.channelId,
    );
    return contactChannel?.externalId ?? null;
  }
}
