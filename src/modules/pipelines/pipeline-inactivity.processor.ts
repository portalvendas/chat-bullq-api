import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { NotificationType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

export const PIPELINE_INACTIVITY_QUEUE = 'pipeline-inactivity';
export const PIPELINE_INACTIVITY_SCAN_JOB = 'scan-inactive-cards';

/**
 * Varre cards ABERTOS de funis não arquivados e notifica responsável+gestores
 * quando o card fica sem interação além do prazo configurado.
 *
 * Prazo efetivo = etapa.inactivityHours ?? pipeline.inactivityHours. NULL nos
 * dois = card ignorado.
 *
 * "Última interação" = max(conversation.lastMessageAt, card.updatedAt) — mover
 * o card ou uma mensagem nova resetam o relógio. Notifica UMA vez por período
 * ocioso: grava `metadata.inactivityNotifiedAt`; só volta a notificar quando
 * houver atividade nova (lastActivity avança além do flag).
 */
@Processor(PIPELINE_INACTIVITY_QUEUE, { concurrency: 1 })
export class PipelineInactivityProcessor extends WorkerHost {
  private readonly logger = new Logger(PipelineInactivityProcessor.name);
  private static readonly BATCH = 500;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(_job: Job): Promise<{ scanned: number; notified: number }> {
    // Funis (não arquivados) e etapas COM prazo configurado.
    const [pipes, stages] = await Promise.all([
      this.prisma.pipeline.findMany({
        where: { archived: false, inactivityHours: { not: null } },
        select: { id: true, inactivityHours: true },
      }),
      this.prisma.pipelineStage.findMany({
        where: { inactivityHours: { not: null } },
        select: { id: true, inactivityHours: true, pipelineId: true },
      }),
    ]);

    const pipeThreshold = new Map(pipes.map((p) => [p.id, p.inactivityHours!]));
    const stageThreshold = new Map(
      stages.map((s) => [s.id, s.inactivityHours!]),
    );
    const pipeIds = [...pipeThreshold.keys()];
    const stageIds = [...stageThreshold.keys()];
    if (pipeIds.length === 0 && stageIds.length === 0) {
      return { scanned: 0, notified: 0 };
    }

    const cards = await this.prisma.card.findMany({
      where: {
        status: 'OPEN',
        pipeline: { archived: false },
        OR: [
          ...(pipeIds.length ? [{ pipelineId: { in: pipeIds } }] : []),
          ...(stageIds.length ? [{ stageId: { in: stageIds } }] : []),
        ],
      },
      select: {
        id: true,
        organizationId: true,
        pipelineId: true,
        stageId: true,
        assignedToId: true,
        title: true,
        updatedAt: true,
        metadata: true,
        conversation: { select: { lastMessageAt: true } },
        contact: { select: { name: true } },
      },
      take: PipelineInactivityProcessor.BATCH,
    });

    const now = Date.now();
    let notified = 0;

    for (const card of cards) {
      const hours = stageThreshold.get(card.stageId) ?? pipeThreshold.get(card.pipelineId);
      if (!hours || hours <= 0) continue;

      const lastActivity = Math.max(
        card.conversation?.lastMessageAt?.getTime() ?? 0,
        card.updatedAt.getTime(),
      );
      const idleMs = now - lastActivity;
      if (idleMs < hours * 3_600_000) continue;

      const meta = (card.metadata as Record<string, any>) ?? {};
      const notifiedAt = meta.inactivityNotifiedAt
        ? new Date(meta.inactivityNotifiedAt).getTime()
        : 0;
      // Já avisou e não houve atividade nova desde então → não repete.
      if (notifiedAt >= lastActivity) continue;

      const idleHours = Math.floor(idleMs / 3_600_000);
      const who = card.contact?.name ? ` (${card.contact.name})` : '';

      try {
        await this.notifications.notifyManagersAndUser({
          organizationId: card.organizationId,
          responsibleUserId: card.assignedToId,
          type: 'CARD_INACTIVE' as NotificationType,
          title: 'Lead parado no funil',
          body: `${card.title}${who} está há ${idleHours}h sem interação.`,
          data: {
            kind: 'card_inactive',
            cardId: card.id,
            pipelineId: card.pipelineId,
            stageId: card.stageId,
            idleHours,
          },
        });
        await this.prisma.card.update({
          where: { id: card.id },
          data: {
            metadata: { ...meta, inactivityNotifiedAt: new Date().toISOString() },
          },
        });
        notified += 1;
      } catch (err: any) {
        this.logger.warn(
          `Falha ao notificar card inativo ${card.id}: ${err?.message}`,
        );
      }
    }

    if (notified > 0) {
      this.logger.log(
        `pipeline_inactivity_scan scanned=${cards.length} notified=${notified}`,
      );
    }
    return { scanned: cards.length, notified };
  }
}
