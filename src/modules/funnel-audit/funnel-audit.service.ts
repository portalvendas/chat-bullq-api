import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { LlmService } from '../ai-agents/llm/llm.service';
import { PipelinesService } from '../pipelines/pipelines.service';
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
  inactivityHours: number | null;
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
  ) {}

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
          inactivityHours: true,
          stages: {
            select: {
              id: true,
              name: true,
              type: true,
              order: true,
              inactivityHours: true,
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
          updatedAt: true,
          contact: { select: { name: true } },
          conversation: { select: { id: true, lastMessageAt: true } },
        },
        take: MAX_CARDS,
      });
      const scanned = cards.length;

      // ── Regras: shortlist de candidatos (cards com sinal) ──
      const candidates: Candidate[] = [];
      for (const card of cards) {
        const pipeline = pipeMap.get(card.pipelineId);
        if (!pipeline) continue;
        const stages = pipeline.stages as StageLite[];
        const stage = stages.find((s) => s.id === card.stageId);
        if (!stage) continue;
        // Etapas fechadas (WON/LOST) não entram — já concluídas.
        if (stage.type !== 'NORMAL') continue;

        const threshHours =
          stage.inactivityHours ?? pipeline.inactivityHours ?? null;
        const lastAt = card.conversation?.lastMessageAt ?? card.updatedAt;
        const idleHours =
          (Date.now() - new Date(lastAt).getTime()) / 3_600_000;
        const stalled =
          threshHours != null ? idleHours >= threshHours : idleHours >= 24 * 7;
        if (!stalled) continue;

        candidates.push({
          cardId: card.id,
          pipelineId: card.pipelineId,
          title: card.title ?? null,
          value: card.value != null ? Number(card.value) : null,
          contactName: card.contact?.name ?? null,
          conversationId: card.conversation?.id ?? null,
          stage,
          stages,
          idleHours,
          threshHours,
        });
      }
      const flagged = candidates.length;

      // Ordena mais parados primeiro e limita o custo de IA.
      candidates.sort((a, b) => b.idleHours - a.idleHours);
      const toAnalyze = candidates.slice(0, MAX_AI);

      // ── IA (fallback regra) em lotes ──
      const drafts: DraftSuggestion[] = [];
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

      await this.prisma.funnelAuditRun.update({
        where: { id: runId },
        data: {
          status: 'DONE',
          finishedAt: new Date(),
          cardsScanned: scanned,
          cardsFlagged: flagged,
          suggestions: drafts.length,
          aiUsed,
        },
      });
      this.logger.log(
        `[funnel-audit] run=${runId} done scanned=${scanned} flagged=${flagged} suggestions=${drafts.length} ai=${aiUsed}`,
      );
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
            select: { direction: true, type: true, content: true },
          })
        : [];
      const transcript = messages
        .reverse()
        .map((m) => {
          const who = m.direction === 'INBOUND' ? 'Cliente' : 'Vendedor';
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

  // ── Ações ──────────────────────────────────────────────────────────

  async applySuggestion(organizationId: string, id: string) {
    const s = await this.prisma.funnelAuditSuggestion.findFirst({
      where: { id, organizationId },
    });
    if (!s) throw new NotFoundException('Sugestão não encontrada');
    if (s.status !== 'PENDING')
      throw new BadRequestException('Sugestão já resolvida');
    if (!s.suggestedStageId)
      throw new BadRequestException('Sugestão sem etapa de destino');

    // Move o card de verdade (trata WON/LOST pelo tipo da etapa, realtime, etc).
    await this.pipelines.moveCard(s.cardId, organizationId, {
      toStageId: s.suggestedStageId,
      toIndex: 0,
    });
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

const SYSTEM_PROMPT = `Você é um auditor de funil de vendas de um CRM. Recebe a etapa atual de um lead, a lista de etapas do funil (com tipo e ordem) e o histórico recente da conversa. Decida se o lead deveria MUDAR de etapa agora.

Regras:
- Só sugira mudança se houver evidência clara na conversa ou no tempo parado.
- Se o cliente demonstrou interesse/avançou, sugira avançar para a etapa adequada.
- Se esfriou, sumiu ou recusou, considere retroceder ou marcar como PERDIDO.
- Se fechou negócio, marque GANHO.
- Na dúvida ou sem sinal, responda "manter".

Responda SOMENTE com um JSON, sem texto extra:
{"targetStage": "<nome EXATO de uma etapa da lista, ou manter>", "action": "avancar|retroceder|ganho|perdido|manter", "confidence": "baixa|media|alta", "reason": "1 frase curta em português"}`;
