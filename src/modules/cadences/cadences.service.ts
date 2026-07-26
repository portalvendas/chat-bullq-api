import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  MessageContentType,
  MessageDirection,
  MessageStatus,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CADENCE_QUEUE } from './cadences.constants';

/** Passo TIPADO do workflow do salesbot. */
export type WorkflowStep =
  | { type: 'message'; text: string }
  | { type: 'wait'; delayMinutes: number }
  | { type: 'action'; action: 'tag' | 'move_stage' | 'close'; value?: string };

/** Formato LEGADO (régua linear): vira [wait, message] na normalização. */
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
  triggerType?: 'MANUAL' | 'TAG_ADDED';
  triggerValue?: string | null;
  stopOnReply?: boolean;
  businessHoursOnly?: boolean;
  steps?: Array<WorkflowStep | LegacyStep>;
  onEnd?: CadenceOnEnd;
}

/** Normaliza passos (aceita tipados novos + legado linear) em WorkflowStep[]. */
function normalizeSteps(raw: unknown): WorkflowStep[] {
  const arr = Array.isArray(raw) ? raw : [];
  const out: WorkflowStep[] = [];
  for (const s of arr) {
    if (!s || typeof s !== 'object') continue;
    const o = s as Record<string, any>;
    if (o.type === 'message' || o.type === 'wait' || o.type === 'action') {
      out.push(o as WorkflowStep);
    } else if (typeof o.text === 'string') {
      // legado { delayMinutes, text } → espera + mensagem
      if (Number(o.delayMinutes) > 0) {
        out.push({ type: 'wait', delayMinutes: Number(o.delayMinutes) });
      }
      out.push({ type: 'message', text: o.text });
    }
  }
  return out;
}

/**
 * Cadências (follow-up/drip) — réguas de reengajamento com passos temporizados,
 * migradas dos Salesbots do Kommo. O disparo cria um CadenceRun e enfileira o
 * 1º passo na fila `cadence` (BullMQ delayed). O processor manda a mensagem,
 * checa se o cliente respondeu (para) e agenda o próximo passo.
 */
@Injectable()
export class CadencesService {
  private readonly logger = new Logger(CadencesService.name);

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
      throw new NotFoundException('Cadência não encontrada');
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
        steps: (dto.steps ?? []) as any,
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
        ...(dto.steps !== undefined ? { steps: dto.steps as any } : {}),
        ...(dto.onEnd !== undefined ? { onEnd: dto.onEnd as any } : {}),
      },
    });
  }

  async remove(id: string, organizationId: string) {
    await this.get(id, organizationId);
    await this.prisma.cadence.delete({ where: { id } });
  }

  // ─── Disparo ───────────────────────────────────
  /** Inicia a cadência numa conversa. Idempotente por conversa (não duplica
   *  se já há um run RUNNING dessa cadência na conversa). */
  async start(
    id: string,
    organizationId: string,
    conversationId: string,
  ): Promise<{ started: boolean; reason?: string }> {
    const cadence = await this.get(id, organizationId);
    if (!cadence.active) return { started: false, reason: 'inactive' };
    const steps = normalizeSteps(cadence.steps);
    if (steps.length === 0) return { started: false, reason: 'no_steps' };

    const existing = await this.prisma.cadenceRun.findFirst({
      where: { cadenceId: id, conversationId, status: 'RUNNING' },
    });
    if (existing) return { started: false, reason: 'already_running' };

    const run = await this.prisma.cadenceRun.create({
      data: { cadenceId: id, conversationId, status: 'RUNNING', currentStep: 0 },
    });
    // Começa no passo 0 imediatamente; passos 'wait' agendam o próximo.
    await this.scheduleStep(run.id, 0, 0);
    this.logger.log(`Cadência ${cadence.name} iniciada (run ${run.id}) conv ${conversationId}`);
    return { started: true };
  }

  /**
   * Auto-disparo por TAG: chamado quando uma tag é aplicada a uma conversa.
   * Inicia toda cadência ativa cujo gatilho é essa tag. Best-effort (não lança).
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

  private async scheduleStep(runId: string, stepIndex: number, delayMinutes: number) {
    await this.queue.add(
      'cadence-step',
      { runId, stepIndex },
      {
        delay: Math.max(0, Math.round((delayMinutes || 0) * 60_000)),
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: 50,
      },
    );
  }

  /**
   * Executa um passo (chamado pelo processor). Manda a mensagem, checa parada,
   * agenda o próximo ou finaliza. Toda a lógica de estado vive aqui.
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

    // Parar se o cliente respondeu depois que a régua começou.
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
    let waitBeforeNext = 0; // min
    if (step.type === 'message') {
      await this.sendMessage(run.conversationId, cadence.organizationId, step.text);
    } else if (step.type === 'action') {
      await this.applyAction(cadence.organizationId, run.conversationId, step);
    } else if (step.type === 'wait') {
      waitBeforeNext = step.delayMinutes; // o próximo passo sai após o atraso
    }

    await this.prisma.cadenceRun.update({
      where: { id: runId },
      data: { currentStep: stepIndex },
    });

    const next = stepIndex + 1;
    if (next < steps.length) {
      await this.scheduleStep(runId, next, waitBeforeNext);
    } else {
      await this.applyOnEnd(cadence, run.conversationId);
      await this.finish(runId, 'DONE', null);
    }
  }

  /** Aplica um passo de AÇÃO (tag / mover etapa / fechar). */
  private async applyAction(
    organizationId: string,
    conversationId: string,
    step: { action: 'tag' | 'move_stage' | 'close'; value?: string },
  ): Promise<void> {
    const onEnd: CadenceOnEnd = {};
    if (step.action === 'tag') onEnd.tagName = step.value;
    else if (step.action === 'move_stage') onEnd.moveStageId = step.value;
    else if (step.action === 'close') onEnd.close = true;
    await this.applyOnEnd({ onEnd, organizationId }, conversationId);
  }

  private async finish(runId: string, status: 'STOPPED' | 'DONE', reason: string | null) {
    await this.prisma.cadenceRun.update({
      where: { id: runId },
      data: { status, finishedAt: new Date(), stoppedReason: reason },
    });
  }

  /** Envia a mensagem do passo reusando o pipeline de outbound (igual ao
   *  send_message das automações). senderId null = enviado pelo sistema. */
  private async sendMessage(conversationId: string, organizationId: string, text: string) {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId },
      include: { contact: { include: { channels: true } } },
    });
    if (!conversation) return;
    const cc = conversation.contact.channels.find(
      (x) => x.channelId === conversation.channelId,
    );
    if (!cc) return;
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
      { attempts: 5, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: true },
    );
  }

  private async applyOnEnd(
    cadence: { onEnd: unknown; organizationId: string },
    conversationId: string,
  ) {
    const onEnd = (cadence.onEnd as CadenceOnEnd) ?? {};
    try {
      if (onEnd.moveStageId) {
        // move o card da conversa (se houver) pra etapa alvo — best-effort.
        await this.prisma.card.updateMany({
          where: { conversationId, organizationId: cadence.organizationId },
          data: { stageId: onEnd.moveStageId },
        });
      }
      if (onEnd.tagName) {
        // cria/associa a tag na conversa.
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
      this.logger.warn(`onEnd da cadência falhou (conv ${conversationId}): ${err?.message ?? err}`);
    }
  }
}
