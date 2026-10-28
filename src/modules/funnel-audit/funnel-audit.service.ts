import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { LlmService } from '../ai-agents/llm/llm.service';
import { PipelinesService } from '../pipelines/pipelines.service';
import { LeadScopeService } from '../lead-distribution/lead-scope.service';
import { FunnelChecksService, Finding } from './funnel-checks.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  FUNNEL_AUDIT_QUEUE,
  FUNNEL_AUDIT_JOB,
  FunnelAuditJobData,
} from './funnel-audit.constants';

const WINDOW_DAYS = 60;
const MAX_CARDS = Number(process.env.FUNNEL_AUDIT_MAX_CARDS ?? 2000);
const MAX_AI = Number(process.env.FUNNEL_AUDIT_MAX_AI ?? 200);
const AI_CONCURRENCY = 4;
const MODEL_ID = process.env.AI_CHEAP_MODEL ?? 'claude-haiku-4-5';

type StageLite = {
  id: string;
  name: string;
  type: 'NORMAL' | 'WON' | 'LOST';
  order: number;
  inactivityMinutes: number | null;
};

interface Candidate {
  cardId: string;
  pipelineId: string;
  title: string | null;
  value: number | null;
  contactName: string | null;
  conversationId: string | null;
  stage: StageLite;
  stages: StageLite[];
  idleHours: number;
  threshHours: number | null;
  /** Orçamentos/pedidos do Tiny do contato (90 dias). */
  tiny: { quotes: number; lastQuote: string | null; orders: number; lastOrder: string | null };
}

interface DraftSuggestion {
  cardId: string;
  pipelineId: string;
  currentStageId: string;
  suggestedStageId: string | null;
  action: string; // ADVANCE | REGRESS | WON | LOST | KEEP
  reason: string;
  confidence: string; // LOW | MEDIUM | HIGH
  source: string; // ai | rule
}

@Injectable()
export class FunnelAuditService {
  private readonly logger = new Logger(FunnelAuditService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(FUNNEL_AUDIT_QUEUE) private readonly queue: Queue,
    private readonly llm: LlmService,
    private readonly pipelines: PipelinesService,
    private readonly checks: FunnelChecksService,
    private readonly leadScope: LeadScopeService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Disparo AGENDADO: um run por empresa ativa (não suspensa, com funil).
   * Run agendado = requestedById nulo → ao terminar, avisa cada vendedora.
   */
  async scheduleAll(): Promise<number> {
    const orgs = await this.prisma.organization.findMany({
      where: { suspendedAt: null, pipelines: { some: { archived: false } } },
      select: { id: true },
    });
    let n = 0;
    for (const o of orgs) {
      try {
        const r = await this.startRun(o.id);
        if (!r.alreadyRunning) n++;
      } catch (err: any) {
        this.logger.warn(`[funnel-audit] agenda falhou org=${o.id}: ${err?.message ?? err}`);
      }
    }
    return n;
  }

  /**
   * Resumo pós-auditoria AGENDADA: cada vendedora recebe os achados DELA que
   * pedem ação; gestores (fora da distribuição) recebem o total da equipe.
   * Só o que é urgente entra no aviso; o detalhe fica na tela.
   */
  private async notifySummary(organizationId: string, findings: Finding[]): Promise<void> {
    const URGENT: Record<string, string> = {
      AGUARDANDO_RESPOSTA: 'cliente(s) esperando resposta',
      LEAD_NOVO_SEM_CONTATO: 'lead(s) novo(s) sem contato',
      ORCAMENTO_SEM_FOLLOWUP: 'orçamento(s) sem follow-up',
      CARD_SEM_CONVERSA: 'card(s) sem conversa iniciada',
    };
    const fmt = (list: Finding[]) =>
      Object.entries(URGENT)
        .map(([t, label]) => [list.filter((f) => f.type === t).length, label] as const)
        .filter(([n]) => n > 0)
        .map(([n, label]) => `${n} ${label}`)
        .join(', ');
    const hora = new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' });
    const data = { kind: 'funnel_audit', url: '/funnel-audit' };

    const byOwner = new Map<string, Finding[]>();
    for (const f of findings) if (f.ownerUserId) byOwner.set(f.ownerUserId, [...(byOwner.get(f.ownerUserId) ?? []), f]);
    for (const [userId, list] of byOwner) {
      const body = fmt(list);
      if (!body) continue;
      await this.notifications
        .notify({ recipientId: userId, organizationId, type: 'SYSTEM' as any, title: `Auditoria do funil (${hora})`, body: `Você tem ${body}.`, data })
        .catch((err: any) => this.logger.warn(`aviso auditoria falhou user=${userId}: ${err?.message ?? err}`));
    }

    const sellers = await this.leadScope.sellerIds(organizationId);
    const managers = await this.prisma.userOrganization.findMany({
      where: { organizationId, role: { in: ['OWNER', 'ADMIN'] } },
      select: { userId: true },
    });
    const semVendedora = findings.filter((f) => f.type === 'CARD_SEM_VENDEDOR').length;
    const team = fmt(findings);
    const body = [team, semVendedora ? `${semVendedora} card(s) sem vendedora` : ''].filter(Boolean).join(', ');
    if (!body) return;
    for (const m of managers) {
      if (sellers.has(m.userId)) continue; // vendedora já recebeu o dela
      await this.notifications
        .notify({ recipientId: m.userId, organizationId, type: 'SYSTEM' as any, title: `Auditoria do funil (${hora}) — equipe`, body: `${body}.`, data })
        .catch(() => undefined);
    }
  }

  // ── Disparo ────────────────────────────────────────────────────────

  /** Cria o run (RUNNING) e enfileira o trabalho. Idempotente-ish: recusa se já
   *  houver um run RUNNING da org (evita corridas). */
  async startRun(
    organizationId: string,
    userId?: string,
    pipelineIds?: string[],
  ) {
    const running = await this.prisma.funnelAuditRun.findFirst({
      where: { organizationId, status: 'RUNNING' },
      select: { id: true, startedAt: true },
    });
    if (running) {
      // Se travou há muito tempo (>30min), deixa criar outro; senão devolve o atual.
      const ageMin =
        (Date.now() - new Date(running.startedAt).getTime()) / 60000;
      if (ageMin < 30) return { runId: running.id, alreadyRunning: true };
    }
    const run = await this.prisma.funnelAuditRun.create({
      data: {
        organizationId,
        status: 'RUNNING',
        requestedById: userId ?? null,
        windowDays: WINDOW_DAYS,
      },
      select: { id: true },
    });
    const data: FunnelAuditJobData = {
      runId: run.id,
      organizationId,
      pipelineIds: pipelineIds?.length ? pipelineIds : undefined,
    };
    await this.queue.add(FUNNEL_AUDIT_JOB, data, {
      removeOnComplete: 20,
      removeOnFail: 20,
    });
    return { runId: run.id, alreadyRunning: false };
  }

  // ── Execução (chamada pelo processor) ──────────────────────────────

  async executeRun(
    runId: string,
    organizationId: string,
    pipelineIds?: string[],
  ): Promise<void> {
    try {
      const cutoff = new Date(Date.now() - WINDOW_DAYS * 86_400_000);

      const pipelines = await this.prisma.pipeline.findMany({
        where: {
          organizationId,
          archived: false,
          ...(pipelineIds?.length ? { id: { in: pipelineIds } } : {}),
        },
        select: {
          id: true,
          inactivityMinutes: true,
          stages: {
            select: {
              id: true,
              name: true,
              type: true,
              order: true,
              inactivityMinutes: true,
            },
            orderBy: { order: 'asc' },
          },
        },
      });
      const pipeMap = new Map(pipelines.map((p) => [p.id, p]));

      const cards = await this.prisma.card.findMany({
        where: {
          organizationId,
          status: 'OPEN',
          ...(pipelineIds?.length ? { pipelineId: { in: pipelineIds } } : {}),
          OR: [
            { updatedAt: { gte: cutoff } },
            { createdAt: { gte: cutoff } },
            { conversation: { lastMessageAt: { gte: cutoff } } },
          ],
        },
        select: {
          id: true,
          title: true,
          value: true,
          stageId: true,
          pipelineId: true,
          contactId: true,
          createdAt: true,
          contact: { select: { name: true } },
          conversation: { select: { id: true, lastMessageAt: true } },
        },
        take: MAX_CARDS,
      });
      const scanned = cards.length;

      // Atividade REAL do lead: última mensagem em QUALQUER conversa do
      // contato (não só a vinculada ao card) e último movimento do card no
      // funil. Nunca cards.updatedAt (processos internos mexem nele).
      const contactIds = [...new Set(cards.map((c) => c.contactId).filter((x): x is string => !!x))];
      const cardIds = cards.map((c) => c.id);
      const [convAgg, convLatest, evAgg, docs] = await Promise.all([
        contactIds.length
          ? this.prisma.conversation.groupBy({
              by: ['contactId'],
              where: { organizationId, contactId: { in: contactIds } },
              _max: { lastMessageAt: true },
            })
          : [],
        contactIds.length
          ? this.prisma.conversation.findMany({
              where: { organizationId, contactId: { in: contactIds } },
              orderBy: { lastMessageAt: 'desc' },
              select: { id: true, contactId: true },
            })
          : [],
        cardIds.length
          ? this.prisma.cardEvent.groupBy({
              by: ['cardId'],
              where: { organizationId, cardId: { in: cardIds } },
              _max: { createdAt: true },
            })
          : [],
        contactIds.length
          ? this.prisma.tinyDocument.findMany({
              where: {
                organizationId,
                contactId: { in: contactIds },
                kind: { in: ['ORCAMENTO', 'PEDIDO'] },
                data: { gte: new Date(Date.now() - 90 * 86_400_000) },
              },
              select: { contactId: true, kind: true, numero: true, valor: true, data: true, situacao: true, isMarketplace: true, natureza: true },
              orderBy: { data: 'desc' },
            })
          : [],
      ]);
      const lastMsgByContact = new Map(convAgg.map((g) => [g.contactId, g._max.lastMessageAt]));
      const convByContact = new Map<string, string>();
      for (const c of convLatest) if (!convByContact.has(c.contactId)) convByContact.set(c.contactId, c.id);
      const lastMoveByCard = new Map(evAgg.map((g) => [g.cardId, g._max.createdAt]));
      const isVenda = (d: { situacao: string | null; isMarketplace: boolean | null; natureza: string | null }) =>
        !['Cancelada', 'Dados Incompletos', 'Removido'].includes(String(d.situacao ?? '')) &&
        d.isMarketplace !== true &&
        /venda/i.test(String(d.natureza ?? ''));
      const docsByContact = new Map<string, typeof docs>();
      for (const d of docs) {
        if (!d.contactId) continue;
        docsByContact.set(d.contactId, [...(docsByContact.get(d.contactId) ?? []), d]);
      }
      const fmtDoc = (d?: { numero: string | null; valor: unknown; data: Date | null }) =>
        d ? `nº ${d.numero ?? '?'} de ${d.data ? d.data.toISOString().slice(0, 10) : '?'}${d.valor != null ? ` (R$ ${Number(d.valor)})` : ''}` : null;

      // ── Regras: shortlist de candidatos (cards com sinal) ──
      const candidates: Candidate[] = [];
      const ruleDrafts: DraftSuggestion[] = [];
      for (const card of cards) {
        const pipeline = pipeMap.get(card.pipelineId);
        if (!pipeline) continue;
        const stages = pipeline.stages as StageLite[];
        const stage = stages.find((s) => s.id === card.stageId);
        if (!stage) continue;
        // Etapas fechadas (WON/LOST) não entram — já concluídas.
        if (stage.type !== 'NORMAL') continue;

        const cDocs = card.contactId ? (docsByContact.get(card.contactId) ?? []) : [];
        const orders = cDocs.filter((d) => d.kind === 'PEDIDO' && isVenda(d));
        const quotes = cDocs.filter((d) => d.kind === 'ORCAMENTO');

        // REGRA FORTE: pedido (venda efetiva) depois que o lead entrou → Ganho.
        const won = stages.find((s) => s.type === 'WON');
        const orderAfter = orders.find(
          (d) => d.data && d.data.getTime() >= card.createdAt.getTime() - 86_400_000,
        );
        if (won && orderAfter) {
          ruleDrafts.push({
            cardId: card.id,
            pipelineId: card.pipelineId,
            currentStageId: stage.id,
            suggestedStageId: won.id,
            action: 'WON',
            reason: `Pedido ${fmtDoc(orderAfter)} no Tiny — lead já comprou.`,
            confidence: 'HIGH',
            source: 'rule',
          });
          continue;
        }

        // O campo agora é em MINUTOS; a auditoria raciocina em horas/dias.
        const threshMinutes =
          stage.inactivityMinutes ?? pipeline.inactivityMinutes ?? null;
        const threshHours = threshMinutes != null ? threshMinutes / 60 : null;
        const lastAt = Math.max(
          card.createdAt.getTime(),
          card.conversation?.lastMessageAt?.getTime() ?? 0,
          (card.contactId ? lastMsgByContact.get(card.contactId)?.getTime() : 0) ?? 0,
          lastMoveByCard.get(card.id)?.getTime() ?? 0,
        );
        const idleHours = (Date.now() - lastAt) / 3_600_000;
        const stalled =
          threshHours != null ? idleHours >= threshHours : idleHours >= 24 * 7;
        if (!stalled) continue;

        candidates.push({
          cardId: card.id,
          pipelineId: card.pipelineId,
          title: card.title ?? null,
          value: card.value != null ? Number(card.value) : null,
          contactName: card.contact?.name ?? null,
          // Conversa do card; sem vínculo, a mais recente do CONTATO.
          conversationId:
            card.conversation?.id ?? (card.contactId ? convByContact.get(card.contactId) ?? null : null),
          stage,
          stages,
          idleHours,
          threshHours,
          tiny: {
            quotes: quotes.length,
            lastQuote: fmtDoc(quotes[0]),
            orders: orders.length,
            lastOrder: fmtDoc(orders[0]),
          },
        });
      }
      const flagged = candidates.length + ruleDrafts.length;

      // Ordena mais parados primeiro e limita o custo de IA.
      candidates.sort((a, b) => b.idleHours - a.idleHours);
      const toAnalyze = candidates.slice(0, MAX_AI);

      // ── IA (fallback regra) em lotes ──
      const drafts: DraftSuggestion[] = [...ruleDrafts];
      let aiUsed = false;
      for (let i = 0; i < toAnalyze.length; i += AI_CONCURRENCY) {
        const batch = toAnalyze.slice(i, i + AI_CONCURRENCY);
        const results = await Promise.all(
          batch.map((c) => this.analyzeCandidate(c, organizationId)),
        );
        for (const r of results) {
          if (!r) continue;
          if (r.source === 'ai') aiUsed = true;
          drafts.push(r);
        }
      }

      if (drafts.length) {
        await this.prisma.funnelAuditSuggestion.createMany({
          data: drafts.map((d) => ({ ...d, runId, organizationId })),
        });
      }

      // ── Checagens do processo comercial (SQL, sem IA) ──
      const findings = await this.checks.run(organizationId);
      const runRow = await this.prisma.funnelAuditRun.findUnique({
        where: { id: runId },
        select: { requestedById: true },
      });
      if (findings.length) {
        await this.prisma.funnelAuditFinding.createMany({
          data: findings.map((f) => ({
            runId,
            organizationId,
            type: f.type,
            severity: f.severity,
            cardId: f.cardId,
            conversationId: f.conversationId,
            contactId: f.contactId,
            ownerUserId: f.ownerUserId,
            minutes: f.minutes,
            details: f.details as any,
          })),
        });
      }

      await this.prisma.funnelAuditRun.update({
        where: { id: runId },
        data: {
          status: 'DONE',
          finishedAt: new Date(),
          cardsScanned: scanned,
          cardsFlagged: flagged,
          suggestions: drafts.length,
          findings: findings.length,
          aiUsed,
        },
      });
      this.logger.log(
        `[funnel-audit] run=${runId} done scanned=${scanned} flagged=${flagged} suggestions=${drafts.length} findings=${findings.length} ai=${aiUsed}`,
      );
      // Run agendado (sem solicitante) → avisa cada vendedora e os gestores.
      if (!runRow?.requestedById) {
        await this.notifySummary(organizationId, findings).catch((err: any) =>
          this.logger.warn(`[funnel-audit] resumo falhou: ${err?.message ?? err}`),
        );
      }
    } catch (err: any) {
      this.logger.error(
        `[funnel-audit] run=${runId} FALHOU: ${err?.message ?? err}`,
      );
      await this.prisma.funnelAuditRun
        .update({
          where: { id: runId },
          data: {
            status: 'FAILED',
            finishedAt: new Date(),
            error: String(err?.message ?? err).slice(0, 500),
          },
        })
        .catch(() => undefined);
    }
  }

  // ── Análise de um candidato (IA + fallback determinístico) ─────────

  private async analyzeCandidate(
    c: Candidate,
    organizationId: string,
  ): Promise<DraftSuggestion | null> {
    const idleDays = Math.round(c.idleHours / 24);
    try {
      const messages = c.conversationId
        ? await this.prisma.message.findMany({
            where: { conversationId: c.conversationId },
            orderBy: { createdAt: 'desc' },
            take: 15,
            select: { direction: true, type: true, content: true, senderId: true, metadata: true },
          })
        : [];
      const transcript = messages
        .reverse()
        .map((m) => {
          const echo = (m.metadata as { isEcho?: boolean } | null)?.isEcho === true;
          const who =
            m.direction === 'INBOUND' ? 'Cliente' : m.senderId || echo ? 'Vendedora' : 'Robô';
          const txt = this.messageText(m.content, m.type);
          return `${who}: ${txt}`;
        })
        .join('\n')
        .slice(0, 4000);

      const stageList = c.stages
        .map(
          (s) =>
            `- ${s.name} (${s.type === 'NORMAL' ? 'etapa' : s.type === 'WON' ? 'GANHO' : 'PERDIDO'}, ordem ${s.order})`,
        )
        .join('\n');

      const user = [
        `Etapas do funil (em ordem):`,
        stageList,
        ``,
        `Etapa atual do lead: "${c.stage.name}"`,
        `Valor: ${c.value != null ? `R$ ${c.value}` : 'não informado'}`,
        `Parado há: ${idleDays} dia(s)${c.threshHours != null ? ` (limiar da etapa: ${Math.round(c.threshHours / 24)}d)` : ''}`,
        `Tiny ERP (90 dias): ${c.tiny.quotes} orçamento(s)${c.tiny.lastQuote ? `, último ${c.tiny.lastQuote}` : ''}; ${c.tiny.orders} pedido(s)${c.tiny.lastOrder ? `, último ${c.tiny.lastOrder}` : ''}`,
        ``,
        `Últimas mensagens (mais antigas primeiro):`,
        transcript || '(sem conversa registrada)',
      ].join('\n');

      const res = await this.llm.complete({
        modelId: MODEL_ID,
        organizationId,
        maxTokens: 220,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: user },
        ],
      });
      const parsed = this.parseJson(this.textOf(res.message.content));
      if (!parsed) return this.ruleFallback(c, idleDays);

      const target = String(parsed.targetStage ?? '').trim();
      if (!target || /manter|^keep$/i.test(target)) return null; // sem mudança

      const dest = c.stages.find(
        (s) => s.name.toLowerCase() === target.toLowerCase(),
      );
      if (!dest || dest.id === c.stage.id) return null;

      // Trava: orçamento em aberto ou pedido → não sugere "perdido" só pelo
      // silêncio (a IA às vezes confunde demora com desistência).
      if (dest.type === 'LOST' && (c.tiny.quotes > 0 || c.tiny.orders > 0)) return null;

      return {
        cardId: c.cardId,
        pipelineId: c.pipelineId,
        currentStageId: c.stage.id,
        suggestedStageId: dest.id,
        action: this.actionOf(c.stage, dest),
        reason: String(parsed.reason ?? '').slice(0, 300) || 'Sugerido pela IA.',
        confidence: this.confOf(parsed.confidence),
        source: 'ai',
      };
    } catch (err: any) {
      this.logger.warn(
        `[funnel-audit] IA falhou p/ card ${c.cardId}: ${err?.message ?? err}`,
      );
      return this.ruleFallback(c, idleDays);
    }
  }

  /** Sem IA: só sugere quando o card está MUITO parado — provável perdido. */
  private ruleFallback(c: Candidate, idleDays: number): DraftSuggestion | null {
    const veryStale =
      c.threshHours != null
        ? c.idleHours >= c.threshHours * 3
        : c.idleHours >= 24 * 30;
    if (!veryStale) return null;
    if (c.tiny.quotes > 0 || c.tiny.orders > 0) return null; // tem negócio no Tiny
    const lost = c.stages.find((s) => s.type === 'LOST');
    if (!lost) return null;
    return {
      cardId: c.cardId,
      pipelineId: c.pipelineId,
      currentStageId: c.stage.id,
      suggestedStageId: lost.id,
      action: 'LOST',
      reason: `Parado há ${idleDays} dias sem avanço — provável perda. Revisar.`,
      confidence: 'LOW',
      source: 'rule',
    };
  }

  private actionOf(from: StageLite, to: StageLite): string {
    if (to.type === 'WON') return 'WON';
    if (to.type === 'LOST') return 'LOST';
    return to.order > from.order ? 'ADVANCE' : 'REGRESS';
  }
  private confOf(v: unknown): string {
    const s = String(v ?? '').toLowerCase();
    if (/alta|high/.test(s)) return 'HIGH';
    if (/baixa|low/.test(s)) return 'LOW';
    return 'MEDIUM';
  }
  private textOf(content: unknown): string {
    if (typeof content === 'string') return content;
    if (Array.isArray(content))
      return content
        .filter((p: any) => p?.type === 'text')
        .map((p: any) => p.text)
        .join('\n');
    return '';
  }
  private parseJson(text: string): Record<string, any> | null {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch {
      return null;
    }
  }
  private messageText(content: unknown, type: string): string {
    const c = content as Record<string, any> | null;
    const t = (c && typeof c.text === 'string' && c.text) || '';
    if (t) return t.slice(0, 400);
    return `[${type.toLowerCase()}]`;
  }

  // ── Leitura ────────────────────────────────────────────────────────

  async getLatestRun(organizationId: string) {
    return this.prisma.funnelAuditRun.findFirst({
      where: { organizationId },
      orderBy: { startedAt: 'desc' },
    });
  }

  async listSuggestions(
    organizationId: string,
    opts: {
      runId?: string;
      status?: string;
      pipelineId?: string;
      page?: number;
      limit?: number;
    },
  ) {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const skip = (Math.max(opts.page ?? 1, 1) - 1) * take;
    const runId =
      opts.runId ?? (await this.getLatestRun(organizationId))?.id ?? undefined;
    const where: any = { organizationId };
    if (runId) where.runId = runId;
    if (opts.status) where.status = opts.status;
    if (opts.pipelineId) where.pipelineId = opts.pipelineId;
    // Vendedora só vê sugestões dos leads dela.
    const me = await this.leadScope.restrictedUserId(organizationId);
    if (me) where.card = { assignedToId: me };

    const [total, rows] = await Promise.all([
      this.prisma.funnelAuditSuggestion.count({ where }),
      this.prisma.funnelAuditSuggestion.findMany({
        where,
        orderBy: [{ confidence: 'desc' }, { createdAt: 'desc' }],
        skip,
        take,
        include: {
          card: {
            select: {
              id: true,
              title: true,
              value: true,
              conversationId: true,
              contact: { select: { name: true, phone: true } },
            },
          },
        },
      }),
    ]);

    // nomes de etapas + funil
    const stageIds = [
      ...new Set(
        rows.flatMap((r) =>
          [r.currentStageId, r.suggestedStageId].filter(Boolean),
        ),
      ),
    ] as string[];
    const stages = stageIds.length
      ? await this.prisma.pipelineStage.findMany({
          where: { id: { in: stageIds } },
          select: {
            id: true,
            name: true,
            pipeline: { select: { id: true, name: true } },
          },
        })
      : [];
    const stageName = new Map(stages.map((s) => [s.id, s.name]));
    const pipeName = new Map(
      stages.map((s) => [s.pipeline.id, s.pipeline.name]),
    );

    return {
      runId: runId ?? null,
      items: rows.map((r) => ({
        id: r.id,
        cardId: r.cardId,
        pipelineId: r.pipelineId,
        pipelineName: pipeName.get(r.pipelineId) ?? null,
        currentStageId: r.currentStageId,
        currentStageName: stageName.get(r.currentStageId) ?? null,
        suggestedStageId: r.suggestedStageId,
        suggestedStageName: r.suggestedStageId
          ? (stageName.get(r.suggestedStageId) ?? null)
          : null,
        action: r.action,
        reason: r.reason,
        confidence: r.confidence,
        source: r.source,
        status: r.status,
        lead: {
          title: r.card?.title ?? null,
          name: r.card?.contact?.name ?? null,
          phone: r.card?.contact?.phone ?? null,
          value: r.card?.value != null ? Number(r.card.value) : null,
          conversationId: r.card?.conversationId ?? null,
        },
      })),
      pagination: {
        page: Math.max(opts.page ?? 1, 1),
        limit: take,
        total,
        totalPages: Math.max(1, Math.ceil(total / take)),
      },
    };
  }

  /**
   * Achados das CHECAGENS DO PROCESSO do último run (ou de `runId`), com
   * resumo por tipo e por vendedora. Vendedora vê só os achados dela.
   *
   * GET /funnel-audit/findings?type=AGUARDANDO_RESPOSTA&ownerUserId=…&page=1
   * → { runId, finishedAt, summary: { byType: [{type,label,count,high}], bySeller: [...] },
   *     items: [{ type, label, severity, minutes, lead, owner, cardId, conversationId, ... }],
   *     pagination }
   */
  async listFindings(
    organizationId: string,
    opts: { runId?: string; type?: string; ownerUserId?: string; page?: number; limit?: number },
  ) {
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const skip = (Math.max(opts.page ?? 1, 1) - 1) * take;
    const run = opts.runId
      ? await this.prisma.funnelAuditRun.findFirst({ where: { id: opts.runId, organizationId } })
      : await this.prisma.funnelAuditRun.findFirst({
          where: { organizationId, status: 'DONE' },
          orderBy: { startedAt: 'desc' },
        });
    if (!run) {
      return { runId: null, finishedAt: null, summary: { byType: [], bySeller: [] }, items: [], pagination: { page: 1, limit: take, total: 0, totalPages: 1 } };
    }
    const me = await this.leadScope.restrictedUserId(organizationId);
    const base: any = { organizationId, runId: run.id, ...(me ? { ownerUserId: me } : {}) };
    const where: any = {
      ...base,
      ...(opts.type ? { type: opts.type } : {}),
      ...(opts.ownerUserId && !me
        ? { ownerUserId: opts.ownerUserId === 'none' ? null : opts.ownerUserId }
        : {}),
    };

    const [byTypeRaw, bySellerRaw, total, idRows] = await Promise.all([
      this.prisma.funnelAuditFinding.groupBy({ by: ['type', 'severity'], where: base, _count: { _all: true } }),
      this.prisma.funnelAuditFinding.groupBy({
        by: ['ownerUserId'],
        where: { ...base, ...(opts.type ? { type: opts.type } : {}) },
        _count: { _all: true },
      }),
      this.prisma.funnelAuditFinding.count({ where }),
      // Ordem: gravidade (alta → baixa), depois o que está há mais tempo.
      this.prisma.$queryRaw<{ id: string }[]>`
        SELECT id FROM funnel_audit_findings
        WHERE organization_id = ${organizationId} AND run_id = ${run.id}
          ${me ? Prisma.sql`AND owner_user_id = ${me}` : Prisma.empty}
          ${opts.type ? Prisma.sql`AND type = ${opts.type}` : Prisma.empty}
          ${opts.ownerUserId && !me
            ? opts.ownerUserId === 'none'
              ? Prisma.sql`AND owner_user_id IS NULL`
              : Prisma.sql`AND owner_user_id = ${opts.ownerUserId}`
            : Prisma.empty}
        ORDER BY CASE severity WHEN 'HIGH' THEN 0 WHEN 'MEDIUM' THEN 1 ELSE 2 END,
                 array_position(ARRAY[${Prisma.join(Object.keys(FINDING_LABEL))}]::text[], type),
                 minutes DESC NULLS LAST, id
        OFFSET ${skip} LIMIT ${take}`,
    ]);
    const pageIds = idRows.map((r) => r.id);
    const unordered = pageIds.length
      ? await this.prisma.funnelAuditFinding.findMany({ where: { organizationId, id: { in: pageIds } } })
      : [];
    const pos = new Map(pageIds.map((id, i) => [id, i]));
    const rows = unordered.sort((a, b) => (pos.get(a.id) ?? 0) - (pos.get(b.id) ?? 0));

    const userIds = [...new Set([...bySellerRaw.map((r) => r.ownerUserId), ...rows.map((r) => r.ownerUserId)].filter((x): x is string => !!x))];
    const cardIds = rows.map((r) => r.cardId).filter((x): x is string => !!x);
    const contactIds = rows.map((r) => r.contactId).filter((x): x is string => !!x);
    const [users, cards, contacts, convs] = await Promise.all([
      userIds.length ? this.prisma.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } }) : [],
      cardIds.length
        ? this.prisma.card.findMany({
            where: { organizationId, id: { in: cardIds } },
            select: { id: true, title: true, pipelineId: true, pipeline: { select: { name: true } }, stage: { select: { name: true } } },
          })
        : [],
      contactIds.length
        ? this.prisma.contact.findMany({ where: { organizationId, id: { in: contactIds } }, select: { id: true, name: true, phone: true } })
        : [],
      contactIds.length
        ? this.prisma.conversation.findMany({
            where: { organizationId, contactId: { in: contactIds } },
            orderBy: { lastMessageAt: 'desc' },
            select: { id: true, contactId: true },
          })
        : [],
    ]);
    const userName = new Map(users.map((u) => [u.id, u.name]));
    const cardById = new Map(cards.map((c) => [c.id, c]));
    const contactById = new Map(contacts.map((c) => [c.id, c]));
    const convByContact = new Map<string, string>();
    for (const c of convs) if (!convByContact.has(c.contactId)) convByContact.set(c.contactId, c.id);

    const typeMap = new Map<string, { count: number; high: number }>();
    for (const r of byTypeRaw) {
      const cur = typeMap.get(r.type) ?? { count: 0, high: 0 };
      cur.count += r._count._all;
      if (r.severity === 'HIGH') cur.high += r._count._all;
      typeMap.set(r.type, cur);
    }
    const order = Object.keys(FINDING_LABEL);
    return {
      runId: run.id,
      finishedAt: run.finishedAt,
      scheduled: !run.requestedById,
      summary: {
        byType: [...typeMap.entries()]
          .map(([type, v]) => ({ type, label: FINDING_LABEL[type] ?? type, ...v }))
          .sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type)),
        bySeller: bySellerRaw
          .map((r) => ({ userId: r.ownerUserId, name: r.ownerUserId ? userName.get(r.ownerUserId) ?? '—' : 'Sem vendedora', count: r._count._all }))
          .sort((a, b) => b.count - a.count),
      },
      items: rows.map((r) => {
        const card = r.cardId ? cardById.get(r.cardId) : undefined;
        const contact = r.contactId ? contactById.get(r.contactId) : undefined;
        return {
          id: r.id,
          type: r.type,
          label: FINDING_LABEL[r.type] ?? r.type,
          severity: r.severity,
          minutes: r.minutes,
          details: r.details,
          cardId: r.cardId,
          pipelineId: card?.pipelineId ?? null,
          pipeline: card?.pipeline?.name ?? null,
          stage: card?.stage?.name ?? null,
          conversationId: r.conversationId ?? (r.contactId ? convByContact.get(r.contactId) ?? null : null),
          lead: { name: contact?.name ?? card?.title ?? null, phone: contact?.phone ?? null },
          owner: r.ownerUserId ? { id: r.ownerUserId, name: userName.get(r.ownerUserId) ?? null } : null,
        };
      }),
      pagination: { page: Math.max(opts.page ?? 1, 1), limit: take, total, totalPages: Math.max(1, Math.ceil(total / take)) },
    };
  }

  // ── Ações ──────────────────────────────────────────────────────────

  async applySuggestion(organizationId: string, id: string, actorId?: string) {
    const s = await this.prisma.funnelAuditSuggestion.findFirst({
      where: { id, organizationId },
    });
    if (!s) throw new NotFoundException('Sugestão não encontrada');
    if (s.status !== 'PENDING')
      throw new BadRequestException('Sugestão já resolvida');
    if (!s.suggestedStageId)
      throw new BadRequestException('Sugestão sem etapa de destino');

    // Move o card de verdade (trata WON/LOST pelo tipo da etapa, realtime, etc).
    await this.pipelines.moveCard(
      s.cardId,
      organizationId,
      { toStageId: s.suggestedStageId, toIndex: 0 },
      actorId ?? null,
    );
    await this.prisma.funnelAuditSuggestion.update({
      where: { id: s.id },
      data: { status: 'APPLIED', appliedAt: new Date() },
    });
    return { ok: true };
  }

  async dismissSuggestion(organizationId: string, id: string) {
    const s = await this.prisma.funnelAuditSuggestion.findFirst({
      where: { id, organizationId },
      select: { id: true, status: true },
    });
    if (!s) throw new NotFoundException('Sugestão não encontrada');
    if (s.status !== 'PENDING')
      throw new BadRequestException('Sugestão já resolvida');
    await this.prisma.funnelAuditSuggestion.update({
      where: { id },
      data: { status: 'DISMISSED' },
    });
    return { ok: true };
  }
}

/** Rótulos dos achados das checagens do processo (ordem = prioridade). */
export const FINDING_LABEL: Record<string, string> = {
  AGUARDANDO_RESPOSTA: 'Cliente esperando resposta',
  LEAD_NOVO_SEM_CONTATO: 'Lead novo sem contato da vendedora',
  ORCAMENTO_SEM_FOLLOWUP: 'Orçamento sem follow-up',
  CARD_SEM_CONVERSA: 'Card sem conversa (só formulário)',
  CARD_PARADO: 'Card parado além do prazo',
  CARD_SEM_VENDEDOR: 'Card sem vendedora',
  CONVERSA_SEM_CARD: 'Conversa fora do funil (sem card)',
  VENDEDOR_DIVERGENTE: 'Vendedora do card ≠ da conversa',
  LEAD_DUPLICADO: 'Lead duplicado',
};

const SYSTEM_PROMPT = `Você é um auditor de funil de vendas de um CRM. Recebe a etapa atual de um lead, a lista de etapas do funil (com tipo e ordem) e o histórico recente da conversa. Decida se o lead deveria MUDAR de etapa agora.

No histórico, "Vendedora" é uma pessoa da equipe e "Robô" é mensagem automática (boas-vindas, follow-up). Mensagem do Robô NÃO é atendimento.

Regras:
- Só sugira mudança se houver evidência clara na conversa, no tempo parado ou no Tiny ERP.
- Orçamento em aberto no Tiny = negociação em andamento: não marque PERDIDO sem recusa explícita do cliente.
- Se o cliente demonstrou interesse/avançou, sugira avançar para a etapa adequada.
- Se esfriou, sumiu ou recusou, considere retroceder ou marcar como PERDIDO.
- Se fechou negócio, marque GANHO.
- Na dúvida ou sem sinal, responda "manter".

Responda SOMENTE com um JSON, sem texto extra:
{"targetStage": "<nome EXATO de uma etapa da lista, ou manter>", "action": "avancar|retroceder|ganho|perdido|manter", "confidence": "baixa|media|alta", "reason": "1 frase curta em português"}`;
