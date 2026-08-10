import {
  Injectable,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  MessageContentType,
  MessageDirection,
  MessageStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CADENCE_QUEUE } from './cadences.constants';
import {
  ActionKind,
  GraphNode,
  WorkflowGraph,
  edgeTarget,
  nodeById,
  normalizeSteps,
  resolveGraph,
  shiftIntoBusinessHours,
  startNode,
} from './cadences.graph';
import { KommoModel, kommoToGraph } from './kommo-import';

/** Passo TIPADO do workflow (formato linear legado, ainda aceito no input). */
export type WorkflowStep =
  | { type: 'message'; text: string }
  | { type: 'wait'; delayMinutes: number }
  | { type: 'action'; action: ActionKind; value?: string };

export interface LegacyStep {
  delayMinutes: number;
  text: string;
}
export interface CadenceOnEnd {
  tagName?: string;
  moveStageId?: string;
  close?: boolean;
}
export interface CadenceInput {
  name: string;
  description?: string | null;
  active?: boolean;
  triggerType?: 'MANUAL' | 'TAG_ADDED' | 'STAGE_ENTERED' | 'INACTIVITY';
  triggerValue?: string | null;
  stopOnReply?: boolean;
  businessHoursOnly?: boolean;
  /** Origens permitidas (channelIds). Vazio/ausente = todas. */
  channelFilter?: string[];
  steps?: Array<WorkflowStep | LegacyStep>;
  graph?: WorkflowGraph;
  onEnd?: CadenceOnEnd;
}

const RUNNABLE = ['RUNNING', 'WAITING'] as const;

/**
 * Salesbots (motor com RAMIFICAÇÕES). Cada bot é um grafo de nós; um
 * `CadenceRun` é uma execução que caminha pelo grafo guardando o nó atual
 * (`currentNodeId`). Nós de espera bifurcam entre `timeout` (cronômetro) e
 * `reply` (cliente respondeu). Cadências antigas (lineares) viram grafo
 * automaticamente via `resolveGraph` — sem migração de dados.
 */
@Injectable()
export class CadencesService implements OnModuleInit {
  private readonly logger = new Logger(CadencesService.name);

  /**
   * Agenda o scan de inatividade (job repetível na fila `cadence`). Roda de
   * hora em hora; BullMQ deduplica pela chave de repeat, então re-agendar a
   * cada boot é seguro.
   */
  async onModuleInit() {
    try {
      await this.queue.add(
        'inactivity-scan',
        { kind: 'inactivity-scan' },
        {
          repeat: { every: 60 * 60 * 1000 },
          removeOnComplete: true,
          removeOnFail: 20,
        },
      );
    } catch (err: any) {
      this.logger.warn(`Falha ao agendar inactivity-scan: ${err?.message ?? err}`);
    }
  }

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(CADENCE_QUEUE) private readonly queue: Queue,
    @InjectQueue('outbound-messages') private readonly outbound: Queue,
  ) {}

  // ─── CRUD ──────────────────────────────────────
  list(organizationId: string) {
    return this.prisma.cadence.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { runs: true } } },
    });
  }

  async get(id: string, organizationId: string) {
    const c = await this.prisma.cadence.findUnique({ where: { id } });
    if (!c || c.organizationId !== organizationId) {
      throw new NotFoundException('Salesbot não encontrado');
    }
    return c;
  }

  create(organizationId: string, dto: CadenceInput) {
    return this.prisma.cadence.create({
      data: {
        organizationId,
        name: dto.name,
        description: dto.description ?? null,
        active: dto.active ?? true,
        triggerType: dto.triggerType ?? 'MANUAL',
        triggerValue: dto.triggerValue ?? null,
        stopOnReply: dto.stopOnReply ?? true,
        businessHoursOnly: dto.businessHoursOnly ?? false,
        channelFilter: (dto.channelFilter ?? []) as any,
        steps: (dto.steps ?? []) as any,
        graph: (dto.graph ?? {}) as any,
        onEnd: (dto.onEnd ?? {}) as any,
      },
    });
  }

  async update(id: string, organizationId: string, dto: CadenceInput) {
    await this.get(id, organizationId);
    return this.prisma.cadence.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
        ...(dto.triggerType !== undefined ? { triggerType: dto.triggerType } : {}),
        ...(dto.triggerValue !== undefined ? { triggerValue: dto.triggerValue } : {}),
        ...(dto.stopOnReply !== undefined ? { stopOnReply: dto.stopOnReply } : {}),
        ...(dto.businessHoursOnly !== undefined
          ? { businessHoursOnly: dto.businessHoursOnly }
          : {}),
        ...(dto.channelFilter !== undefined
          ? { channelFilter: dto.channelFilter as any }
          : {}),
        ...(dto.steps !== undefined ? { steps: dto.steps as any } : {}),
        ...(dto.graph !== undefined ? { graph: dto.graph as any } : {}),
        ...(dto.onEnd !== undefined ? { onEnd: dto.onEnd as any } : {}),
      },
    });
  }

  async remove(id: string, organizationId: string) {
    await this.get(id, organizationId);
    await this.prisma.cadence.delete({ where: { id } });
  }

  /**
   * Importa bots exportados do Kommo. Cada arquivo vira um Salesbot com o grafo
   * convertido. Dedupe por nome: bots já existentes são pulados (reimport seguro).
   * Retorna resumo por bot (nós, avisos) pronto pro frontend renderizar.
   */
  async importKommo(
    organizationId: string,
    files: Array<{ name: string; model: KommoModel }>,
  ): Promise<{
    created: number;
    skipped: number;
    results: Array<{
      name: string;
      status: 'created' | 'skipped' | 'error';
      nodes?: number;
      warnings?: string[];
      error?: string;
    }>;
  }> {
    const existing = await this.prisma.cadence.findMany({
      where: { organizationId },
      select: { name: true },
    });
    const existingNames = new Set(existing.map((c) => c.name.trim().toLowerCase()));

    const results: Array<{
      name: string;
      status: 'created' | 'skipped' | 'error';
      nodes?: number;
      warnings?: string[];
      error?: string;
    }> = [];
    let created = 0;
    let skipped = 0;

    for (const f of files ?? []) {
      const name = (f?.name ?? '').trim();
      if (!name) {
        results.push({ name: '(sem nome)', status: 'error', error: 'nome ausente' });
        continue;
      }
      if (existingNames.has(name.toLowerCase())) {
        results.push({ name, status: 'skipped' });
        skipped++;
        continue;
      }
      try {
        const { graph, warnings } = kommoToGraph(f.model ?? {});
        await this.create(organizationId, {
          name,
          triggerType: 'MANUAL',
          stopOnReply: true,
          graph,
          onEnd: {},
        });
        existingNames.add(name.toLowerCase());
        created++;
        results.push({
          name,
          status: 'created',
          nodes: graph.nodes.length,
          warnings,
        });
      } catch (err: any) {
        this.logger.warn(`Falha ao importar bot "${name}": ${err?.message ?? err}`);
        results.push({ name, status: 'error', error: err?.message ?? 'erro' });
      }
    }
    return { created, skipped, results };
  }

  // ─── Disparo ───────────────────────────────────
  /**
   * Inicia o bot numa conversa. Idempotente por conversa (não duplica se já há
   * um run em andamento dessa cadência). Cria o run apontando para o nó de
   * entrada e enfileira o avanço no worker (não bloqueia o caller).
   */
  /**
   * Vincula automaticamente os NÓS DE MENSAGEM de um Salesbot aos templates
   * APROVADOS da org, casando por similaridade de texto (útil pra bots
   * importados do Kommo, cujos nós têm o mesmo texto dos templates). Assim, fora
   * da janela de 24h, o nó envia o template certo em vez de ser bloqueado.
   * execute=false = prévia (não salva).
   */
  async autoLinkTemplates(
    id: string,
    organizationId: string,
    execute = false,
  ): Promise<{
    total: number;
    linked: number;
    execute: boolean;
    results: Array<{
      nodeId: string;
      text: string;
      template: string | null;
      score: number;
    }>;
  }> {
    const cadence = await this.get(id, organizationId);
    const graph = resolveGraph(cadence);
    const templates = await this.prisma.whatsappTemplate.findMany({
      where: { organizationId, status: 'APPROVED' },
      select: { id: true, name: true, bodyText: true },
    });
    const norm = (s: string) =>
      (s || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // acentos
        .replace(/\{\{\s*\d+\s*\}\}/g, ' ') // variáveis {{1}}
        .replace(/[^\p{L}\p{N}]+/gu, ' ') // pontuação/emoji
        .trim();
    const tokens = (s: string) => new Set(norm(s).split(' ').filter(Boolean));
    const sim = (a: Set<string>, b: Set<string>) => {
      if (a.size === 0 || b.size === 0) return 0;
      let inter = 0;
      for (const t of a) if (b.has(t)) inter += 1;
      return inter / (a.size + b.size - inter); // Jaccard
    };
    const tpl = templates.map((t) => ({ ...t, tok: tokens(t.bodyText) }));

    const results: Array<{
      nodeId: string;
      text: string;
      template: string | null;
      score: number;
    }> = [];
    for (const node of graph.nodes) {
      if (node.type !== 'message' || !node.text?.trim()) continue;
      const nt = tokens(node.text);
      let best: (typeof tpl)[number] | null = null;
      let bestScore = 0;
      for (const t of tpl) {
        const sc = sim(nt, t.tok);
        if (sc > bestScore) {
          bestScore = sc;
          best = t;
        }
      }
      const matched = best && bestScore >= 0.6 ? best : null;
      if (matched && execute) node.templateId = matched.id;
      results.push({
        nodeId: node.id,
        text: node.text.slice(0, 60),
        template: matched ? matched.name : null,
        score: Math.round(bestScore * 100) / 100,
      });
    }

    if (execute) {
      await this.prisma.cadence.update({
        where: { id },
        data: { graph: graph as any },
      });
    }
    return {
      total: results.length,
      linked: results.filter((r) => r.template).length,
      execute,
      results,
    };
  }

  async start(
    id: string,
    organizationId: string,
    conversationId: string,
  ): Promise<{ started: boolean; reason?: string }> {
    const cadence = await this.get(id, organizationId);
    if (!cadence.active) return { started: false, reason: 'inactive' };

    // Filtro de ORIGEM: se o bot está restrito a canais específicos, só dispara
    // quando a conversa é de um desses canais. Vazio = todas as origens.
    const channelFilter = Array.isArray(cadence.channelFilter)
      ? (cadence.channelFilter as string[])
      : [];
    if (channelFilter.length > 0) {
      const conv = await this.prisma.conversation.findFirst({
        where: { id: conversationId, organizationId },
        select: { channelId: true },
      });
      if (!conv || !channelFilter.includes(conv.channelId)) {
        return { started: false, reason: 'channel_filtered' };
      }
    }

    const graph = resolveGraph(cadence);
    const entry = startNode(graph);
    if (!entry) return { started: false, reason: 'empty_graph' };

    const existing = await this.prisma.cadenceRun.findFirst({
      where: { cadenceId: id, conversationId, status: { in: RUNNABLE as any } },
    });
    if (existing) return { started: false, reason: 'already_running' };

    const run = await this.prisma.cadenceRun.create({
      data: {
        cadenceId: id,
        conversationId,
        status: 'RUNNING',
        currentStep: 0,
        currentNodeId: entry.id,
      },
    });
    await this.enqueueAdvance(run.id, entry.id, 0);
    this.logger.log(
      `Salesbot "${cadence.name}" iniciado (run ${run.id}) conv ${conversationId}`,
    );
    return { started: true };
  }

  /**
   * Auto-disparo por TAG: inicia todo bot ativo cujo gatilho é essa tag.
   * Best-effort (não lança). Chamado pelos hooks de tagueamento.
   */
  async onTagAdded(
    organizationId: string,
    conversationId: string,
    tagName: string,
  ): Promise<void> {
    try {
      const cadences = await this.prisma.cadence.findMany({
        where: {
          organizationId,
          active: true,
          triggerType: 'TAG_ADDED',
          triggerValue: tagName,
        },
        select: { id: true },
      });
      for (const c of cadences) {
        await this.start(c.id, organizationId, conversationId).catch(() => undefined);
      }
    } catch (err: any) {
      this.logger.warn(`onTagAdded falhou (tag ${tagName}): ${err?.message ?? err}`);
    }
  }

  /**
   * Auto-disparo por ETAPA: chamado quando um card entra numa etapa do funil.
   * Inicia todo bot ativo cujo gatilho é STAGE_ENTERED nessa etapa (stageId).
   * Best-effort — espelha o "executar robô ao mover para a etapa" do Kommo.
   */
  async onStageEntered(
    organizationId: string,
    conversationId: string,
    stageId: string,
  ): Promise<void> {
    try {
      const cadences = await this.prisma.cadence.findMany({
        where: {
          organizationId,
          active: true,
          triggerType: 'STAGE_ENTERED',
          triggerValue: stageId,
        },
        select: { id: true },
      });
      for (const c of cadences) {
        await this.start(c.id, organizationId, conversationId).catch(() => undefined);
      }
    } catch (err: any) {
      this.logger.warn(`onStageEntered falhou (stage ${stageId}): ${err?.message ?? err}`);
    }
  }

  /**
   * REENGAJAMENTO POR INATIVIDADE. Para cada bot com gatilho INACTIVITY
   * (triggerValue = nº de dias), acha conversas paradas há ≥ N dias (e ≤ 90d,
   * pra não ressuscitar leads mortos), sem run prévio dessa cadência, e inicia
   * o bot. Chamado pelo job repetível. Best-effort.
   */
  async scanInactivity(): Promise<void> {
    const cadences = await this.prisma.cadence.findMany({
      where: { active: true, triggerType: 'INACTIVITY' },
    });
    const now = Date.now();
    for (const c of cadences) {
      try {
        const days = Math.max(1, Number(c.triggerValue) || 1);
        const cutoff = new Date(now - days * 86_400_000);
        const floor = new Date(now - 90 * 86_400_000);
        const convs = await this.prisma.conversation.findMany({
          where: {
            organizationId: c.organizationId,
            status: { not: 'CLOSED' },
            lastMessageAt: { lt: cutoff, gt: floor },
          },
          select: { id: true },
          take: 300,
        });
        if (convs.length === 0) continue;
        const ids = convs.map((x) => x.id);
        const runs = await this.prisma.cadenceRun.findMany({
          where: { cadenceId: c.id, conversationId: { in: ids } },
          select: { conversationId: true },
        });
        const already = new Set(runs.map((r) => r.conversationId));
        for (const conv of convs) {
          if (already.has(conv.id)) continue;
          await this.start(c.id, c.organizationId, conv.id).catch(() => undefined);
        }
      } catch (err: any) {
        this.logger.warn(
          `scanInactivity falhou (cadence ${c.id}): ${err?.message ?? err}`,
        );
      }
    }
  }

  // ─── Motor (grafo) ─────────────────────────────
  private async enqueueAdvance(runId: string, nodeId: string, delayMs = 0) {
    await this.queue.add(
      'cadence-advance',
      { runId, nodeId, kind: 'advance' },
      {
        delay: Math.max(0, Math.round(delayMs)),
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
  }

  private async scheduleTimeout(runId: string, node: GraphNode) {
    const minutes = Number(node.delayMinutes) || 0;
    let fireAt = Date.now() + minutes * 60_000;
    if (node.businessHoursOnly) fireAt = shiftIntoBusinessHours(fireAt);
    await this.queue.add(
      'cadence-timeout',
      { runId, nodeId: node.id, kind: 'timeout' },
      {
        delay: Math.max(0, fireAt - Date.now()),
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
  }

  /**
   * Caminha pelo grafo a partir de `fromNodeId`, executando nós sem espera
   * (message/action/start) em sequência até topar num `wait` (agenda timeout e
   * para) ou `stop` (finaliza). Guard contra grafos cíclicos.
   */
  async advance(runId: string, fromNodeId: string): Promise<void> {
    let nodeId: string | null = fromNodeId;

    for (let guard = 0; guard < 200 && nodeId; guard++) {
      const run = await this.prisma.cadenceRun.findUnique({ where: { id: runId } });
      if (!run || !(RUNNABLE as readonly string[]).includes(run.status)) return;

      const cadence = await this.prisma.cadence.findUnique({
        where: { id: run.cadenceId },
      });
      if (!cadence || !cadence.active) {
        await this.finish(runId, 'DONE', 'cadence_inactive');
        return;
      }

      const graph = resolveGraph(cadence);
      const node = nodeById(graph, nodeId);
      if (!node) {
        await this.finish(runId, 'DONE', 'node_missing');
        return;
      }

      await this.prisma.cadenceRun.update({
        where: { id: runId },
        data: { currentNodeId: nodeId, status: 'RUNNING' },
      });

      if (node.type === 'stop') {
        await this.applyOnEnd(cadence, run.conversationId);
        await this.finish(runId, 'DONE', null);
        return;
      }

      if (node.type === 'wait') {
        await this.prisma.cadenceRun.update({
          where: { id: runId },
          data: { status: 'WAITING' },
        });
        await this.scheduleTimeout(runId, node);
        return; // aguarda timeout OU reply
      }

      if (node.type === 'message') {
        if (node.text?.trim() || node.templateId || node.mediaUrl) {
          const res = await this.sendMessage(
            run.conversationId,
            cadence.organizationId,
            node.text ?? '',
            node.templateId,
            node.mediaUrl
              ? {
                  url: node.mediaUrl,
                  type: node.mediaType,
                  fileName: node.fileName,
                }
              : undefined,
          );
          // Fora da janela de 24h e sem template aprovado → NÃO envia e PARA o
          // bot, pra nunca mandar mensagem livre fora do template (Meta).
          if (res === 'blocked') {
            await this.finish(runId, 'STOPPED', 'outside_24h_no_template');
            return;
          }
        }
      } else if (node.type === 'action') {
        await this.applyAction(cadence.organizationId, run.conversationId, {
          action: node.action ?? 'close',
          value: node.value,
        });
        if (node.action === 'close') {
          await this.finish(runId, 'DONE', 'closed');
          return;
        }
      }

      // start / message / action → segue pela saída "out"
      nodeId = edgeTarget(graph, node.id, 'out');
    }

    // sem próximo nó → encerra
    await this.finish(runId, 'DONE', null);
  }

  /** Cronômetro de um nó de espera estourou → pega a saída "timeout". */
  async onTimeout(runId: string, nodeId: string): Promise<void> {
    const run = await this.prisma.cadenceRun.findUnique({ where: { id: runId } });
    // Stale guard: só age se o run ainda espera NESTE nó (reply pode ter
    // movido o cursor antes do timeout chegar).
    if (!run || run.status !== 'WAITING' || run.currentNodeId !== nodeId) return;

    const cadence = await this.prisma.cadence.findUnique({
      where: { id: run.cadenceId },
    });
    if (!cadence || !cadence.active) {
      await this.finish(runId, 'DONE', 'cadence_inactive');
      return;
    }
    const graph = resolveGraph(cadence);
    const next = edgeTarget(graph, nodeId, 'timeout') ?? edgeTarget(graph, nodeId, 'out');
    if (!next) {
      await this.applyOnEnd(cadence, run.conversationId);
      await this.finish(runId, 'DONE', null);
      return;
    }
    await this.advance(runId, next);
  }

  /**
   * Cliente respondeu na conversa. Para cada run em espera:
   *   - se o nó atual (wait) tem saída "reply", segue por ela (ramificação);
   *   - senão, se `stopOnReply`, encerra o run (comportamento clássico).
   * Best-effort — chamado pelo pipeline de inbound.
   */
  async onCustomerReply(conversationId: string): Promise<void> {
    try {
      const runs = await this.prisma.cadenceRun.findMany({
        where: { conversationId, status: { in: RUNNABLE as any } },
      });
      for (const run of runs) {
        const cadence = await this.prisma.cadence.findUnique({
          where: { id: run.cadenceId },
        });
        if (!cadence) continue;
        const graph = resolveGraph(cadence);
        const node = nodeById(graph, run.currentNodeId);
        const replyTarget =
          node && node.type === 'wait' ? edgeTarget(graph, node.id, 'reply') : null;

        if (replyTarget) {
          await this.advance(run.id, replyTarget);
        } else if (cadence.stopOnReply) {
          await this.finish(run.id, 'STOPPED', 'cliente_respondeu');
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `onCustomerReply falhou (conv ${conversationId}): ${err?.message ?? err}`,
      );
    }
  }

  /**
   * LEGADO: consome jobs `cadence-step` que ainda possam estar na fila (em voo
   * antes do deploy do motor de grafo). Executa o passo linear e agenda o
   * próximo. Novos runs não usam este caminho.
   */
  async runStep(runId: string, stepIndex: number): Promise<void> {
    const run = await this.prisma.cadenceRun.findUnique({ where: { id: runId } });
    if (!run || run.status !== 'RUNNING') return;
    const cadence = await this.prisma.cadence.findUnique({
      where: { id: run.cadenceId },
    });
    if (!cadence || !cadence.active) {
      await this.finish(runId, 'DONE', 'cadence_inactive');
      return;
    }
    const steps = normalizeSteps(cadence.steps);
    if (stepIndex >= steps.length) {
      await this.applyOnEnd(cadence, run.conversationId);
      await this.finish(runId, 'DONE', null);
      return;
    }
    if (cadence.stopOnReply) {
      const reply = await this.prisma.message.findFirst({
        where: {
          conversationId: run.conversationId,
          direction: MessageDirection.INBOUND,
          createdAt: { gt: run.startedAt },
        },
        select: { id: true },
      });
      if (reply) {
        await this.finish(runId, 'STOPPED', 'cliente_respondeu');
        return;
      }
    }
    const step = steps[stepIndex];
    let waitBeforeNext = 0;
    if (step.type === 'message') {
      await this.sendMessage(run.conversationId, cadence.organizationId, step.text);
    } else if (step.type === 'action') {
      await this.applyAction(cadence.organizationId, run.conversationId, step);
    } else if (step.type === 'wait') {
      waitBeforeNext = step.delayMinutes;
    }
    await this.prisma.cadenceRun.update({
      where: { id: runId },
      data: { currentStep: stepIndex },
    });
    const next = stepIndex + 1;
    if (next < steps.length) {
      await this.queue.add(
        'cadence-step',
        { runId, stepIndex: next },
        {
          delay: Math.max(0, Math.round((waitBeforeNext || 0) * 60_000)),
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: 50,
        },
      );
    } else {
      await this.applyOnEnd(cadence, run.conversationId);
      await this.finish(runId, 'DONE', null);
    }
  }

  // ─── Efeitos ───────────────────────────────────
  private async applyAction(
    organizationId: string,
    conversationId: string,
    step: { action: ActionKind; value?: string },
  ): Promise<void> {
    const onEnd: CadenceOnEnd = {};
    if (step.action === 'tag') onEnd.tagName = step.value;
    else if (step.action === 'move_stage') onEnd.moveStageId = step.value;
    else if (step.action === 'close') onEnd.close = true;
    await this.applyOnEnd({ onEnd, organizationId }, conversationId);
  }

  private async finish(
    runId: string,
    status: 'STOPPED' | 'DONE',
    reason: string | null,
  ) {
    await this.prisma.cadenceRun.update({
      where: { id: runId },
      data: { status, finishedAt: new Date(), stoppedReason: reason },
    });
  }

  /**
   * Envia a mensagem do nó reusando o pipeline de outbound. ENVIO INTELIGENTE:
   * em canal WhatsApp oficial, se a janela de atendimento de 24h estiver
   * FECHADA (cliente não responde há +24h), envia como TEMPLATE aprovado
   * (obrigatório pela Meta); dentro da janela, ou em outros canais, envia
   * texto livre. Se estiver fora da janela e não houver template aprovado,
   * envia o texto assim mesmo (o WhatsApp pode bloquear) e loga o aviso.
   */
  private async sendMessage(
    conversationId: string,
    organizationId: string,
    text: string,
    templateId?: string,
    media?: { url?: string; type?: 'DOCUMENT' | 'IMAGE'; fileName?: string },
  ): Promise<'sent' | 'blocked' | 'skipped'> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId },
      include: { channel: true, contact: { include: { channels: true } } },
    });
    if (!conversation) return 'skipped';
    const cc = conversation.contact.channels.find(
      (x) => x.channelId === conversation.channelId,
    );
    if (!cc) return 'skipped';

    const isWhatsAppOfficial = conversation.channel?.type === 'WHATSAPP_OFFICIAL';
    let windowOpen = true;
    if (isWhatsAppOfficial) {
      const lastInbound = await this.prisma.message.findFirst({
        where: { conversationId, direction: MessageDirection.INBOUND },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      windowOpen =
        !!lastInbound &&
        Date.now() - lastInbound.createdAt.getTime() < 24 * 60 * 60 * 1000;
    }

    // ANEXO (documento/imagem — ex.: catálogo/PDF). Fora da janela de 24h no
    // WhatsApp Oficial, mídia livre também é bloqueada pela Meta (exigiria
    // template com cabeçalho de mídia) → bloqueia. Dentro da janela ou outros
    // canais, envia o arquivo; `text` vira legenda.
    if (media?.url) {
      if (isWhatsAppOfficial && !windowOpen) {
        this.logger.warn(
          `Salesbot BLOQUEADO (mídia) na conv ${conversationId}: fora da janela de 24h — anexo NÃO enviado.`,
        );
        return 'blocked';
      }
      const contentType =
        media.type === 'IMAGE'
          ? MessageContentType.IMAGE
          : MessageContentType.DOCUMENT;
      const content: Record<string, any> = { mediaUrl: media.url };
      if (media.fileName) content.fileName = media.fileName;
      if (text.trim()) content.caption = text.trim();
      const message = await this.prisma.message.create({
        data: {
          conversationId,
          direction: MessageDirection.OUTBOUND,
          type: contentType,
          content,
          status: MessageStatus.QUEUED,
          senderId: null,
          metadata: { source: 'cadence' },
        },
      });
      await this.outbound.add(
        'send-outbound',
        {
          messageId: message.id,
          channelId: conversation.channelId,
          contactExternalId: cc.externalId,
          message: {
            type: media.type === 'IMAGE' ? 'IMAGE' : 'DOCUMENT',
            content,
          },
        },
        {
          attempts: 5,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
        },
      );
      return 'sent';
    }

    // FORA da janela de 24h num canal WhatsApp Oficial: a Meta SÓ aceita
    // template aprovado. Se houver template aprovado, envia; senão, BLOQUEIA
    // (não manda texto livre, que seria rejeitado/penalizado). O chamador
    // interrompe o bot ao ver 'blocked'.
    if (isWhatsAppOfficial && !windowOpen) {
      const tpl = templateId
        ? await this.prisma.whatsappTemplate.findFirst({
            where: { id: templateId, organizationId },
          })
        : null;
      if (tpl && tpl.status === 'APPROVED' && (tpl.metaName || tpl.name)) {
        const metaName = tpl.metaName ?? this.toMetaName(tpl.name);
        const message = await this.prisma.message.create({
          data: {
            conversationId,
            direction: MessageDirection.OUTBOUND,
            type: MessageContentType.TEMPLATE,
            content: { text: tpl.bodyText, template: { name: metaName } },
            status: MessageStatus.QUEUED,
            senderId: null,
            metadata: { source: 'cadence', templateId, viaTemplate: true },
          },
        });
        await this.outbound.add(
          'send-outbound',
          {
            messageId: message.id,
            channelId: conversation.channelId,
            contactExternalId: cc.externalId,
            message: {
              type: 'TEMPLATE',
              content: { name: metaName, language: { code: tpl.language } },
            },
          },
          {
            attempts: 5,
            backoff: { type: 'exponential', delay: 2000 },
            removeOnComplete: true,
          },
        );
        return 'sent';
      }
      this.logger.warn(
        `Salesbot BLOQUEADO na conv ${conversationId}: fora da janela de 24h e sem template aprovado — mensagem NÃO enviada (evita envio fora do template).`,
      );
      return 'blocked';
    }

    // Texto livre (dentro da janela ou outros canais).
    if (!text.trim()) return 'skipped';
    const message = await this.prisma.message.create({
      data: {
        conversationId,
        direction: MessageDirection.OUTBOUND,
        type: MessageContentType.TEXT,
        content: { text },
        status: MessageStatus.QUEUED,
        senderId: null,
        metadata: { source: 'cadence' },
      },
    });
    await this.outbound.add(
      'send-outbound',
      {
        messageId: message.id,
        channelId: conversation.channelId,
        contactExternalId: cc.externalId,
        message: { type: 'TEXT', content: { text } },
      },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
      },
    );
    return 'sent';
  }

  /** Normaliza nome p/ o padrão da Meta (fallback quando falta metaName). */
  private toMetaName(name: string): string {
    return (
      name
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 480) || 'template'
    );
  }

  private async applyOnEnd(
    cadence: { onEnd: unknown; organizationId: string },
    conversationId: string,
  ) {
    const onEnd = (cadence.onEnd as CadenceOnEnd) ?? {};
    try {
      if (onEnd.moveStageId) {
        // Etapa destino (ordem + funil) e etapa ATUAL do card (antes do move),
        // pra decidir se dispara o gatilho da etapa destino.
        const destStage = await this.prisma.pipelineStage.findUnique({
          where: { id: onEnd.moveStageId },
          select: { order: true, pipelineId: true },
        });
        const cardBefore = destStage
          ? await this.prisma.card.findFirst({
              where: {
                conversationId,
                organizationId: cadence.organizationId,
                pipelineId: destStage.pipelineId,
              },
              select: { stage: { select: { order: true } } },
            })
          : null;

        await this.prisma.card.updateMany({
          where: { conversationId, organizationId: cadence.organizationId },
          data: { stageId: onEnd.moveStageId },
        });

        // Dispara os Salesbots com gatilho STAGE_ENTERED da etapa destino —
        // MAS só em AVANÇO no funil (dest.order > origem.order). Assim um bot
        // que move o card pra frente encadeia o bot da próxima etapa, sem
        // risco de loop (dois bots empurrando o card de ida e volta).
        const oldOrder = cardBefore?.stage?.order;
        if (destStage && oldOrder != null && destStage.order > oldOrder) {
          void this.onStageEntered(
            cadence.organizationId,
            conversationId,
            onEnd.moveStageId,
          ).catch(() => undefined);
        }
      }
      if (onEnd.tagName) {
        const tag = await this.prisma.tag.upsert({
          where: {
            organizationId_name: {
              organizationId: cadence.organizationId,
              name: onEnd.tagName,
            },
          },
          create: { organizationId: cadence.organizationId, name: onEnd.tagName },
          update: {},
        });
        await this.prisma.conversationTag.upsert({
          where: { conversationId_tagId: { conversationId, tagId: tag.id } },
          create: { conversationId, tagId: tag.id },
          update: {},
        });
      }
      if (onEnd.close) {
        await this.prisma.conversation.update({
          where: { id: conversationId },
          data: { status: 'CLOSED', closedAt: new Date() },
        });
      }
    } catch (err: any) {
      this.logger.warn(
        `onEnd do salesbot falhou (conv ${conversationId}): ${err?.message ?? err}`,
      );
    }
  }
}
