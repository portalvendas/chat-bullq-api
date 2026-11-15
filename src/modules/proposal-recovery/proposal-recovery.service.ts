import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AiAgentRunnerService } from '../ai-agents/runner/agent-runner.service';
import { isOpenAt } from '../../common/business-hours/business-hours.util';
import { RecoveryOfferService } from './core/recovery-offer.service';
import {
  ACTIVE_RECOVERY_STATUSES,
  ORCAMENTO_SITUACOES_EXCLUIDAS,
  PEDIDO_SITUACOES_EXCLUIDAS,
  PROPOSAL_RECOVERY_AGENT_CATEGORY,
  recoveryConfig,
} from './proposal-recovery.constants';
import {
  kickoffDirective,
  RECOVERY_AGENT_NAME,
  RECOVERY_AGENT_SYSTEM_PROMPT,
} from './recovery-agent.prompt';
import { DEFAULT_RECOVERY_POLICY } from './core/offer-policy';

interface Candidate {
  id: string;
  organization_id: string;
  contact_id: string;
  assigned_to_id: string | null;
  last_inbound_at: Date;
}

type KickoffResult =
  | { kicked: true; recoveryId: string }
  | { kicked: false; reason: string; error?: string };

/**
 * Orquestra a recuperação de orçamentos:
 *  - scan() (a cada 15 min, BullMQ, concorrência 1):
 *      1. sweep(): marca WON (pedido apareceu no Tiny) e EXPIRED (48h venceu),
 *         devolvendo a IA da conversa ao estado anterior.
 *      2. kickoffs: conversas com cliente calado entre 23h e 23h45 (ainda
 *         dentro da janela de 24h do WhatsApp) + orçamento pendente sem pedido.
 *  - Idempotência: unique(tinyDocumentId) — a mesma proposta nunca é abordada 2x.
 *  - Falha do Tiny: o candidato é pulado e reavaliado no próximo scan (ainda
 *    dentro da janela de 45 min).
 */
@Injectable()
export class ProposalRecoveryService {
  private readonly logger = new Logger(ProposalRecoveryService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly offers: RecoveryOfferService,
    private readonly runner: AiAgentRunnerService,
  ) {}

  // ─── Scan ────────────────────────────────────────────────────────

  async scan(opts: { force?: boolean } = {}) {
    const cfg = recoveryConfig();
    let stage = 'sweep';
    try {
      const swept = await this.sweep();
      if (!cfg.enabled && !opts.force) {
        return { ok: true, enabled: false, ...swept, candidates: 0, kicked: 0 };
      }
      stage = 'find_candidates';
      const candidates = await this.findCandidates(cfg);
      stage = 'kickoff';
      return await this.runKickoffs(cfg, candidates, swept);
    } catch (err: any) {
      this.logger.error(
        `proposal_recovery_scan_failed stage=${stage}: ${err?.message ?? err}`,
        err?.stack,
      );
      if (!opts.force) throw err; // job do BullMQ: deixa falhar e registrar
      // Execução manual (admin): devolve o diagnóstico em vez de 500 opaco.
      return { ok: false, stage, error: String(err?.message ?? err).slice(0, 1000) };
    }
  }

  private async runKickoffs(
    cfg: ReturnType<typeof recoveryConfig>,
    candidates: Candidate[],
    swept: { won: number; expired: number },
  ) {
    let kicked = 0;
    const skipped: Record<string, number> = {};
    const errors: Array<{ conversationId: string; error: string }> = [];
    for (const c of candidates) {
      if (kicked >= cfg.maxKickoffsPerScan) break;
      try {
        const r = await this.kickoff(c);
        if (r.kicked) kicked++;
        else {
          skipped[r.reason] = (skipped[r.reason] ?? 0) + 1;
          if (r.error && errors.length < 5) errors.push({ conversationId: c.id, error: r.error });
        }
      } catch (err: any) {
        skipped.error = (skipped.error ?? 0) + 1;
        if (errors.length < 5) {
          errors.push({ conversationId: c.id, error: String(err?.message ?? err).slice(0, 300) });
        }
        this.logger.error(
          `proposal_recovery_kickoff_failed conv=${c.id}: ${err?.message ?? err}`,
        );
      }
    }
    this.logger.log(
      `proposal_recovery_scan candidates=${candidates.length} kicked=${kicked} won=${swept.won} expired=${swept.expired} skipped=${JSON.stringify(skipped)}`,
    );
    return { ok: true, enabled: cfg.enabled, ...swept, candidates: candidates.length, kicked, skipped, errors };
  }

  private async findCandidates(cfg: ReturnType<typeof recoveryConfig>): Promise<Candidate[]> {
    const minMin = Math.round(cfg.minSilenceHours * 60);
    const maxMin = Math.round(cfg.maxSilenceHours * 60);
    const outMin = Math.round(cfg.skipIfOutboundWithinHours * 60);
    return this.prisma.$queryRaw<Candidate[]>(Prisma.sql`
      SELECT c.id, c.organization_id, c.contact_id, c.assigned_to_id, li.at AS last_inbound_at
      FROM (
        SELECT m.conversation_id, MAX(m.created_at) AS at
        FROM messages m
        WHERE m.direction = 'INBOUND'
          AND m.created_at > NOW() - make_interval(mins => ${maxMin + 120}::int)
        GROUP BY m.conversation_id
      ) li
      JOIN conversations c ON c.id = li.conversation_id
      JOIN channels ch ON ch.id = c.channel_id
      WHERE li.at <= NOW() - make_interval(mins => ${minMin}::int)
        AND li.at >= NOW() - make_interval(mins => ${maxMin}::int)
        AND c.deleted_at IS NULL
        AND c.is_group = false
        AND ch.type::text = ANY(${cfg.channelTypes}::text[])
        AND NOT EXISTS (
          SELECT 1 FROM messages o
          WHERE o.conversation_id = c.id AND o.direction = 'OUTBOUND'
            AND o.created_at > NOW() - make_interval(mins => ${outMin}::int)
        )
        AND EXISTS (
          SELECT 1 FROM tiny_documents d
          WHERE d.organization_id = c.organization_id
            AND d.contact_id = c.contact_id AND d.kind = 'ORCAMENTO'
        )
        AND NOT EXISTS (
          SELECT 1 FROM proposal_recoveries r
          WHERE r.conversation_id = c.id AND r.status IN ('CONTACTED','ENGAGED','HANDED_OFF')
        )
      ORDER BY li.at ASC
      LIMIT 200
    `);
  }

  // ─── Kickoff ─────────────────────────────────────────────────────

  /**
   * Teste manual (admin): aborda UMA conversa escolhida, ignorando a janela de
   * silêncio, o expediente e a trava de mensagem recente. Mantém opt-out,
   * agente obrigatório e modo revisão. `reset` apaga uma recuperação anterior
   * (não-WON) da mesma proposta pra permitir repetir o teste.
   */
  async testKickoff(
    organizationId: string,
    conversationId: string,
    opts: { tinyDocumentId?: string; reset?: boolean } = {},
  ): Promise<KickoffResult & { proposal?: { id: string; numero: string | null } }> {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId, deletedAt: null },
      select: { id: true, organizationId: true, contactId: true, assignedToId: true },
    });
    if (!conv) return { kicked: false, reason: 'conversation_not_found' };

    const lastInbound = await this.prisma.message.findFirst({
      where: { conversationId, direction: 'INBOUND' },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (!lastInbound) return { kicked: false, reason: 'no_inbound' };

    const docWhere = opts.tinyDocumentId
      ? { id: opts.tinyDocumentId, organizationId, kind: 'ORCAMENTO' }
      : { organizationId, contactId: conv.contactId, kind: 'ORCAMENTO' };
    const doc = await this.prisma.tinyDocument.findFirst({
      where: docWhere,
      orderBy: [{ data: 'desc' }, { createdAt: 'desc' }],
      select: { id: true, numero: true, situacao: true, data: true, createdAt: true, vendedor: true },
    });
    if (!doc) return { kicked: false, reason: 'no_proposal_for_contact' };

    // Encerra recuperação viva da conversa e, se pedido, libera a proposta.
    await this.prisma.proposalRecovery.updateMany({
      where: { conversationId, status: { in: [...ACTIVE_RECOVERY_STATUSES] } },
      data: { status: 'EXPIRED', closedAt: new Date(), notes: 'encerrada por teste manual' },
    });
    if (opts.reset) {
      await this.prisma.proposalRecovery.deleteMany({
        where: { tinyDocumentId: doc.id, status: { not: 'WON' } },
      });
    }

    const r = await this.kickoff(
      {
        id: conv.id,
        organization_id: conv.organizationId,
        contact_id: conv.contactId,
        assigned_to_id: conv.assignedToId,
        last_inbound_at: lastInbound.createdAt,
      },
      { ignoreBusinessHours: true, doc },
    );
    return { ...r, proposal: { id: doc.id, numero: doc.numero } };
  }

  async kickoff(
    c: Candidate,
    opts: {
      ignoreBusinessHours?: boolean;
      doc?: { id: string; vendedor: string | null };
    } = {},
  ): Promise<KickoffResult> {
    const [org, contact, agent] = await Promise.all([
      this.prisma.organization.findUnique({ where: { id: c.organization_id } }),
      this.prisma.contact.findUnique({
        where: { id: c.contact_id },
        select: { id: true, broadcastOptedOutAt: true, deletedAt: true },
      }),
      this.findAgent(c.organization_id),
    ]);
    if (!org || !contact || contact.deletedAt) return { kicked: false, reason: 'missing_entity' };
    if (contact.broadcastOptedOutAt) return { kicked: false, reason: 'opted_out' };
    if (!agent) return { kicked: false, reason: 'no_recovery_agent' };
    // Não manda mensagem de madrugada: só no expediente da org.
    if (!opts.ignoreBusinessHours && !isOpenAt(org)) {
      return { kicked: false, reason: 'outside_business_hours' };
    }

    const doc =
      opts.doc ?? (await this.findEligibleProposal(c.organization_id, c.contact_id));
    if (!doc) return { kicked: false, reason: 'no_eligible_proposal' };

    let snapshot;
    try {
      snapshot = await this.offers.buildSnapshot(c.organization_id, doc.id);
    } catch (err: any) {
      this.logger.warn(`tiny_detail_failed doc=${doc.id}: ${err?.message ?? err}`);
      return { kicked: false, reason: 'tiny_unavailable' };
    }

    const conv = await this.prisma.conversation.findUniqueOrThrow({ where: { id: c.id } });
    const vendor = await this.resolveVendor(c.organization_id, doc.vendedor, conv.assignedToId);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DEFAULT_RECOVERY_POLICY.offerValidityHours * 3600_000);
    const previousAiState = {
      aiEnabled: conv.aiEnabled,
      activeAgentId: conv.activeAgentId,
      aiReviewMode: conv.aiReviewMode,
    };

    let recovery;
    try {
      recovery = await this.prisma.proposalRecovery.create({
        data: {
          organizationId: c.organization_id,
          tinyDocumentId: doc.id,
          contactId: c.contact_id,
          conversationId: c.id,
          agentId: agent.id,
          vendorName: vendor.name,
          vendorUserId: vendor.userId,
          status: snapshot.offer.hasAnyOption ? 'CONTACTED' : 'SKIPPED',
          lostReason: snapshot.offer.hasAnyOption ? null : 'sem_condicao_disponivel',
          offer: snapshot as unknown as Prisma.InputJsonValue,
          offerExpiresAt: expiresAt,
          previousAiState,
          lastCustomerMessageAt: c.last_inbound_at,
          closedAt: snapshot.offer.hasAnyOption ? null : now,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { kicked: false, reason: 'already_recovered' };
      }
      throw err;
    }
    if (!snapshot.offer.hasAnyOption) return { kicked: false, reason: 'no_offer_available' };

    const cfg = recoveryConfig();
    const updated = await this.prisma.conversation.update({
      where: { id: c.id },
      data: {
        activeAgentId: agent.id,
        aiEnabled: true,
        // Fase 1 (copiloto): a mensagem do agente fica retida pro vendedor aprovar.
        aiReviewMode: cfg.reviewMode ? true : conv.aiReviewMode,
      },
    });

    const trigger = await this.prisma.message.findFirst({
      where: { conversationId: c.id, direction: 'INBOUND' },
      orderBy: { createdAt: 'desc' },
    });
    if (!trigger) return { kicked: false, reason: 'no_inbound' };

    this.logger.log(
      `proposal_recovery_kickoff conv=${c.id} doc=${doc.id} vendor=${vendor.name ?? '-'} review=${cfg.reviewMode}`,
    );
    // Aguarda o run (o scan já é um job em background, concorrência 1) pra
    // detectar falha do agente (ex.: LLM sem crédito). Em falha: desfaz a
    // abordagem — devolve a IA da conversa e apaga o registro, pra que a
    // proposta possa ser abordada de novo no próximo scan (ainda na janela).
    const startedAt = new Date();
    let runError: string | null = null;
    try {
      await this.runner.run({
        conversation: updated,
        triggerMessage: trigger,
        operatorDirective: kickoffDirective({
          vendedor: vendor.name,
          numero: snapshot.numero,
          validadeTexto: this.offers.formatDeadline(expiresAt),
        }),
      });
      const run = await this.prisma.aiAgentRun.findFirst({
        where: { conversationId: c.id, agentId: agent.id, startedAt: { gte: new Date(startedAt.getTime() - 1000) } },
        orderBy: { startedAt: 'desc' },
        select: { status: true, errorMessage: true },
      });
      if (!run) runError = 'agent_run_not_recorded';
      else if (run.status === 'FAILED') runError = run.errorMessage ?? 'agent_run_failed';
    } catch (err: any) {
      runError = String(err?.message ?? err);
    }
    if (runError) {
      this.logger.error(`proposal_recovery_run_failed conv=${c.id}: ${runError}`);
      await this.offers.releaseConversation({
        conversationId: c.id,
        agentId: agent.id,
        previousAiState,
      });
      await this.prisma.proposalRecovery
        .delete({ where: { id: recovery.id } })
        .catch(() => undefined);
      return { kicked: false, reason: 'agent_run_failed', error: runError.slice(0, 500) };
    }
    return { kicked: true, recoveryId: recovery.id };
  }

  /** Orçamento mais recente do contato, pendente, sem pedido depois e nunca abordado. */
  private async findEligibleProposal(organizationId: string, contactId: string) {
    const cfg = recoveryConfig();
    const since = new Date(Date.now() - cfg.maxProposalAgeDays * 86400_000);
    const docs = await this.prisma.tinyDocument.findMany({
      where: {
        organizationId,
        contactId,
        kind: 'ORCAMENTO',
        OR: [{ data: { gte: since } }, { data: null, createdAt: { gte: since } }],
      },
      orderBy: [{ data: 'desc' }, { createdAt: 'desc' }],
      take: 5,
      select: { id: true, situacao: true, data: true, createdAt: true, vendedor: true },
    });
    for (const d of docs) {
      const sit = (d.situacao ?? '').trim().toLowerCase();
      if (sit && ORCAMENTO_SITUACOES_EXCLUIDAS.includes(sit)) continue;
      const already = await this.prisma.proposalRecovery.findUnique({
        where: { tinyDocumentId: d.id },
        select: { id: true },
      });
      if (already) continue;
      const ref = d.data ?? d.createdAt;
      const refDay = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate());
      const converted = await this.prisma.tinyDocument.findFirst({
        where: {
          organizationId,
          contactId,
          kind: 'PEDIDO',
          situacao: { notIn: PEDIDO_SITUACOES_EXCLUIDAS },
          OR: [{ data: { gte: refDay } }, { createdAt: { gte: d.createdAt } }],
        },
        select: { id: true },
      });
      if (converted) return null; // já virou pedido → nada a recuperar
      return d;
    }
    return null;
  }

  /**
   * Nome do vendedor no Tiny → usuário do CRM (nome completo; senão primeiro
   * nome, se único). Fallback: responsável atual da conversa.
   */
  private async resolveVendor(
    organizationId: string,
    tinyVendedor: string | null,
    assignedToId: string | null,
  ): Promise<{ name: string | null; userId: string | null }> {
    const norm = (s: string) =>
      s.normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase();
    const members = await this.prisma.userOrganization.findMany({
      where: { organizationId, user: { isActive: true, deletedAt: null } },
      select: { user: { select: { id: true, name: true } } },
    });
    const users = members.map((m) => m.user);
    const firstName = (s: string | null | undefined) => (s ? s.trim().split(/\s+/)[0] : null);

    if (tinyVendedor) {
      const target = norm(tinyVendedor);
      const exact = users.find((u) => norm(u.name) === target);
      if (exact) return { name: firstName(tinyVendedor), userId: exact.id };
      const fn = norm(target.split(/\s+/)[0]);
      const byFirst = users.filter((u) => norm(u.name).split(/\s+/)[0] === fn);
      if (byFirst.length === 1) return { name: firstName(tinyVendedor), userId: byFirst[0].id };
      return { name: firstName(tinyVendedor), userId: assignedToId };
    }
    const assigned = users.find((u) => u.id === assignedToId);
    return { name: firstName(assigned?.name) ?? null, userId: assignedToId };
  }

  private findAgent(organizationId: string) {
    return this.prisma.aiAgent.findFirst({
      where: {
        organizationId,
        category: PROPOSAL_RECOVERY_AGENT_CATEGORY,
        isActive: true,
        deletedAt: null,
      },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ─── Sweep: ganhos e expirações ──────────────────────────────────

  async sweep(): Promise<{ won: number; expired: number }> {
    let won = 0;
    let expired = 0;
    const open = await this.prisma.proposalRecovery.findMany({
      where: { status: { in: [...ACTIVE_RECOVERY_STATUSES, 'HANDED_OFF'] } },
      take: 1000,
    });
    for (const r of open) {
      try {
        const pedido = await this.prisma.tinyDocument.findFirst({
          where: {
            organizationId: r.organizationId,
            contactId: r.contactId,
            kind: 'PEDIDO',
            isMarketplace: { not: true },
            situacao: { notIn: PEDIDO_SITUACOES_EXCLUIDAS },
            createdAt: { gte: r.kickedOffAt },
          },
          orderBy: { createdAt: 'asc' },
          select: { id: true, valor: true },
        });
        if (pedido) {
          await this.prisma.proposalRecovery.update({
            where: { id: r.id },
            data: { status: 'WON', wonPedidoId: pedido.id, wonValue: pedido.valor, closedAt: new Date() },
          });
          if (r.status !== 'HANDED_OFF') await this.offers.releaseConversation(r);
          won++;
          continue;
        }
        if (r.status !== 'HANDED_OFF' && r.offerExpiresAt.getTime() <= Date.now()) {
          await this.prisma.proposalRecovery.update({
            where: { id: r.id },
            data: { status: 'EXPIRED', closedAt: new Date() },
          });
          await this.offers.releaseConversation(r);
          expired++;
        }
      } catch (err: any) {
        this.logger.warn(`proposal_recovery_sweep_failed id=${r.id}: ${err?.message ?? err}`);
      }
    }
    return { won, expired };
  }

  // ─── Setup / leitura ─────────────────────────────────────────────

  /** Cria (se não existir) o agente de recuperação da org. NÃO vincula a canais. */
  async ensureAgent(organizationId: string) {
    const existing = await this.prisma.aiAgent.findFirst({
      where: { organizationId, category: PROPOSAL_RECOVERY_AGENT_CATEGORY, deletedAt: null },
    });
    if (existing) return { created: false, agent: { id: existing.id, name: existing.name, isActive: existing.isActive } };
    const agent = await this.prisma.aiAgent.create({
      data: {
        organizationId,
        name: RECOVERY_AGENT_NAME,
        description:
          'Retoma propostas (orçamentos do Tiny) sem resposta há 23h e conduz o fechamento com as condições da política comercial.',
        kind: 'WORKER',
        category: PROPOSAL_RECOVERY_AGENT_CATEGORY,
        department: 'VENDAS',
        modelId: process.env.PROPOSAL_RECOVERY_MODEL ?? 'claude-sonnet-4-6',
        systemPrompt: RECOVERY_AGENT_SYSTEM_PROMPT,
        temperature: 0.5,
        maxTokens: 1024,
        canRespondDirectly: true,
        // Follow-ups próprios da recuperação ficam pra Fase 2 (templates).
        followUpEnabled: false,
      },
    });
    return { created: true, agent: { id: agent.id, name: agent.name, isActive: agent.isActive } };
  }

  async list(organizationId: string, q: { status?: string; page?: number; pageSize?: number }) {
    const pageSize = Math.min(100, Math.max(1, q.pageSize ?? 25));
    const page = Math.max(1, q.page ?? 1);
    const where: Prisma.ProposalRecoveryWhereInput = {
      organizationId,
      ...(q.status ? { status: q.status as any } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.proposalRecovery.count({ where }),
      this.prisma.proposalRecovery.findMany({
        where,
        orderBy: { kickedOffAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ]);
    return { page, pageSize, total, rows };
  }

  /** KPIs prontos pra renderizar. */
  async summary(organizationId: string, days = 30) {
    const since = new Date(Date.now() - days * 86400_000);
    const grouped = await this.prisma.proposalRecovery.groupBy({
      by: ['status'],
      where: { organizationId, kickedOffAt: { gte: since } },
      _count: { _all: true },
      _sum: { wonValue: true },
    });
    const byStatus = Object.fromEntries(grouped.map((g) => [g.status, g._count._all]));
    const contacted = grouped.filter((g) => g.status !== 'SKIPPED').reduce((a, g) => a + g._count._all, 0);
    const replied = contacted - (byStatus.CONTACTED ?? 0) - (byStatus.EXPIRED ?? 0);
    const won = byStatus.WON ?? 0;
    const revenue = Number(grouped.find((g) => g.status === 'WON')?._sum.wonValue ?? 0);
    const objections = await this.prisma.proposalRecovery.groupBy({
      by: ['objection'],
      where: { organizationId, kickedOffAt: { gte: since }, objection: { not: null } },
      _count: { _all: true },
    });
    return {
      periodDays: days,
      contacted,
      repliedApprox: Math.max(0, replied),
      won,
      recoveryRate: contacted ? Number(((won / contacted) * 100).toFixed(1)) : 0,
      recoveredRevenue: revenue,
      byStatus,
      objections: objections.map((o) => ({ objection: o.objection, count: o._count._all })),
    };
  }
}
