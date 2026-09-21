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
import { BroadcastAudienceService, AudienceFilter } from './audience.service';
import { BroadcastPricingService } from './pricing.service';
import { BroadcastBudgetService } from './budget.service';
import { canonicalPhone } from '../../common/phone.util';
import { BROADCAST_SEND_QUEUE, BROADCAST_SEND_JOB } from './broadcast.constants';

const MATERIALIZE_BATCH = 1000;

@Injectable()
export class BroadcastService {
  private readonly logger = new Logger(BroadcastService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audience: BroadcastAudienceService,
    private readonly pricing: BroadcastPricingService,
    private readonly budget: BroadcastBudgetService,
    @InjectQueue(BROADCAST_SEND_QUEUE) private readonly sendQueue: Queue,
  ) {}

  // ── CRUD básico ────────────────────────────────────────────────────

  async create(
    organizationId: string,
    userId: string,
    dto: {
      channelId: string;
      name: string;
      templateName: string;
      templateLanguage: string;
      templateCategory: any;
      variablesMapping?: any;
      audienceFilter: AudienceFilter;
      scheduledAt?: string;
      throttlePerMinute?: number;
    },
  ) {
    const channel = await this.prisma.channel.findFirst({
      where: {
        id: dto.channelId,
        organizationId,
        type: 'WHATSAPP_OFFICIAL',
        deletedAt: null,
      },
    });
    if (!channel) {
      throw new BadRequestException('Canal WhatsApp Oficial inválido.');
    }
    // Valida o filtro cedo (levanta 400 se vazio).
    this.audience.buildWhere(organizationId, dto.audienceFilter);

    return this.prisma.broadcast.create({
      data: {
        organizationId,
        channelId: dto.channelId,
        name: dto.name,
        templateName: dto.templateName,
        templateLanguage: dto.templateLanguage,
        templateCategory: dto.templateCategory,
        variablesMapping: dto.variablesMapping ?? undefined,
        audienceFilter: dto.audienceFilter as unknown as Prisma.InputJsonValue,
        throttlePerMinute: dto.throttlePerMinute ?? 600,
        scheduledAt: dto.scheduledAt ? new Date(dto.scheduledAt) : null,
        status: dto.scheduledAt ? 'SCHEDULED' : 'DRAFT',
        createdByUserId: userId,
      },
    });
  }

  async list(organizationId: string, opts: { cursor?: string; limit?: number } = {}) {
    const take = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const rows = await this.prisma.broadcast.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  async getOne(organizationId: string, id: string) {
    const b = await this.prisma.broadcast.findFirst({
      where: { id, organizationId },
    });
    if (!b) throw new NotFoundException('Disparo não encontrado.');
    const counts = await this.prisma.broadcastRecipient.groupBy({
      by: ['status'],
      where: { broadcastId: id },
      _count: { _all: true },
    });
    const byStatus: Record<string, number> = {};
    for (const c of counts) byStatus[c.status] = c._count._all;
    return { ...b, recipientCounts: byStatus };
  }

  async listRecipients(
    organizationId: string,
    id: string,
    opts: { status?: string; cursor?: string; limit?: number } = {},
  ) {
    await this.assert(organizationId, id);
    const take = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const rows = await this.prisma.broadcastRecipient.findMany({
      where: {
        broadcastId: id,
        ...(opts.status ? { status: opts.status as any } : {}),
      },
      include: { contact: { select: { id: true, name: true, phone: true } } },
      orderBy: { id: 'asc' },
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  private async assert(organizationId: string, id: string) {
    const b = await this.prisma.broadcast.findFirst({
      where: { id, organizationId },
    });
    if (!b) throw new NotFoundException('Disparo não encontrado.');
    return b;
  }

  // ── Disparo ────────────────────────────────────────────────────────

  /**
   * Materializa a audiência (idempotente), RESERVA o custo contra o teto sob
   * advisory lock e enfileira só os PENDING. Rerodar é seguro (skipDuplicates +
   * jobId = recipient.id).
   */
  async start(organizationId: string, id: string) {
    const b = await this.assert(organizationId, id);
    if (['COMPLETED', 'CANCELLED'].includes(b.status)) {
      throw new BadRequestException(`Disparo já está ${b.status}.`);
    }

    const unit = await this.pricing.getUnitMicros(
      'BR',
      b.templateCategory,
      new Date(),
    );
    const filter = b.audienceFilter as unknown as AudienceFilter;

    // Fase A — materializa recipients em lotes (fora de qualquer lock).
    let cursor: string | null = null;
    let materialized = 0;
    do {
      const pageRes = await this.audience.page(organizationId, filter, {
        cursor: cursor ?? undefined,
        limit: MATERIALIZE_BATCH,
      });
      if (pageRes.items.length) {
        const res = await this.prisma.broadcastRecipient.createMany({
          data: pageRes.items.map((c) => ({
            broadcastId: id,
            contactId: c.id,
            phoneE164: canonicalPhone(c.phone) ?? String(c.phone),
            estimatedAmountMicros: unit,
          })),
          skipDuplicates: true,
        });
        materialized += res.count;
      }
      cursor = pageRes.nextCursor;
    } while (cursor);

    const pendingCount = await this.prisma.broadcastRecipient.count({
      where: { broadcastId: id, status: 'PENDING' },
    });
    if (pendingCount === 0) {
      throw new BadRequestException('Nenhum destinatário elegível para disparar.');
    }

    // Fase B — reserva atômica: advisory lock por org + recheck do teto.
    const reserveMicros = unit * BigInt(pendingCount);
    await this.reserveOrThrow(organizationId, id, reserveMicros, pendingCount);

    // Fase C — enfileira só PENDING (idempotente por jobId).
    await this.enqueuePending(id, b.throttlePerMinute);

    return this.getOne(organizationId, id);
  }

  /** Reserva contra o teto sob advisory lock; grava RESERVE + marca RUNNING. */
  private async reserveOrThrow(
    organizationId: string,
    broadcastId: string,
    reserveMicros: bigint,
    pendingCount: number,
  ) {
    // Se já reservou nesta campanha (retry), não reserva de novo.
    const already = await this.prisma.broadcastLedgerEntry.findFirst({
      where: { broadcastId, type: 'RESERVE' },
    });
    if (already) {
      await this.prisma.broadcast.updateMany({
        where: { id: broadcastId, status: { in: ['DRAFT', 'SCHEDULED', 'PAUSED'] } },
        data: { status: 'RUNNING', startedAt: new Date() },
      });
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      // Lock por org — serializa reservas concorrentes.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${organizationId}))`;

      const budget = await tx.organizationBroadcastBudget.findUnique({
        where: { organizationId },
      });
      if (budget && budget.capMicros > 0n) {
        const from =
          budget.period === 'TOTAL'
            ? new Date(0)
            : new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1));
        const sums = await tx.broadcastLedgerEntry.groupBy({
          by: ['type'],
          where: { organizationId, createdAt: { gte: from } },
          _sum: { amountMicros: true },
        });
        const by = (t: string) =>
          sums.find((s) => s.type === t)?._sum.amountMicros ?? 0n;
        const committed = by('RESERVE') - by('RELEASE');
        const available = budget.capMicros - committed;
        if (reserveMicros > available) {
          throw new BadRequestException(
            'Reserva excede o teto de disparos disponível da empresa.',
          );
        }
      }

      await tx.broadcastLedgerEntry.create({
        data: {
          organizationId,
          broadcastId,
          type: 'RESERVE',
          amountMicros: reserveMicros,
          note: `reserva de ${pendingCount} destinatário(s)`,
        },
      });
      await tx.broadcast.update({
        where: { id: broadcastId },
        data: {
          status: 'RUNNING',
          startedAt: new Date(),
          estimatedRecipients: pendingCount,
          estimatedCostMicros: reserveMicros,
        },
      });
    });
  }

  /** Enfileira os recipients PENDING (jobId = recipient.id, idempotente). */
  private async enqueuePending(broadcastId: string, perMinute: number) {
    const pageSize = 5000;
    let cursor: string | null = null;
    do {
      const rows: Array<{ id: string }> =
        await this.prisma.broadcastRecipient.findMany({
          where: { broadcastId, status: 'PENDING' },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: pageSize,
          ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
      if (!rows.length) break;
      await this.sendQueue.addBulk(
        rows.map((r) => ({
          name: BROADCAST_SEND_JOB,
          data: { recipientId: r.id, broadcastId, perMinute },
          opts: {
            jobId: r.id,
            attempts: 5,
            backoff: { type: 'exponential', delay: 5000 },
            removeOnComplete: true,
            removeOnFail: 1000,
          },
        })),
      );
      // Marca como QUEUED (o worker aceita PENDING/QUEUED).
      await this.prisma.broadcastRecipient.updateMany({
        where: { id: { in: rows.map((r) => r.id) }, status: 'PENDING' },
        data: { status: 'QUEUED' },
      });
      cursor = rows[rows.length - 1].id;
    } while (cursor);
  }

  async pause(organizationId: string, id: string) {
    const b = await this.assert(organizationId, id);
    if (b.status !== 'RUNNING') {
      throw new BadRequestException('Só é possível pausar um disparo em execução.');
    }
    await this.prisma.broadcast.update({
      where: { id },
      data: { status: 'PAUSED' },
    });
    // Volta QUEUED→PENDING e drena jobs pendentes best-effort.
    await this.prisma.broadcastRecipient.updateMany({
      where: { broadcastId: id, status: 'QUEUED' },
      data: { status: 'PENDING' },
    });
    await this.drainQueuedJobs(id);
    return this.getOne(organizationId, id);
  }

  async resume(organizationId: string, id: string) {
    const b = await this.assert(organizationId, id);
    if (b.status !== 'PAUSED') {
      throw new BadRequestException('Só é possível retomar um disparo pausado.');
    }
    await this.prisma.broadcast.update({
      where: { id },
      data: { status: 'RUNNING' },
    });
    await this.enqueuePending(id, b.throttlePerMinute);
    return this.getOne(organizationId, id);
  }

  async cancel(organizationId: string, id: string) {
    const b = await this.assert(organizationId, id);
    if (['COMPLETED', 'CANCELLED'].includes(b.status)) {
      throw new BadRequestException(`Disparo já está ${b.status}.`);
    }
    await this.prisma.broadcast.update({
      where: { id },
      data: { status: 'CANCELLED', completedAt: new Date() },
    });
    await this.prisma.broadcastRecipient.updateMany({
      where: { broadcastId: id, status: { in: ['PENDING', 'QUEUED'] } },
      data: { status: 'SKIPPED' },
    });
    await this.drainQueuedJobs(id);
    await this.releaseRemainder(organizationId, id);
    return this.getOne(organizationId, id);
  }

  /** Remove jobs waiting/delayed desta campanha (best-effort). */
  private async drainQueuedJobs(broadcastId: string) {
    try {
      const jobs = await this.sendQueue.getJobs(['waiting', 'delayed', 'paused']);
      await Promise.all(
        jobs
          .filter((j) => j?.data?.broadcastId === broadcastId)
          .map((j) => j.remove().catch(() => undefined)),
      );
    } catch (err: any) {
      this.logger.warn(`drainQueuedJobs falhou (${broadcastId}): ${err?.message ?? err}`);
    }
  }

  /**
   * Libera a sobra da reserva (reserva − cobrado) e grava actualCostMicros.
   * Idempotente: só age se ainda não houve RELEASE nesta campanha.
   */
  async releaseRemainder(organizationId: string, broadcastId: string) {
    const already = await this.prisma.broadcastLedgerEntry.findFirst({
      where: { broadcastId, type: 'RELEASE' },
    });
    if (already) return;
    const sums = await this.prisma.broadcastLedgerEntry.groupBy({
      by: ['type'],
      where: { broadcastId },
      _sum: { amountMicros: true },
    });
    const by = (t: string) => sums.find((s) => s.type === t)?._sum.amountMicros ?? 0n;
    const reserved = by('RESERVE');
    const charged = by('CHARGE');
    const remainder = reserved - charged;
    if (remainder > 0n) {
      await this.prisma.broadcastLedgerEntry.create({
        data: {
          organizationId,
          broadcastId,
          type: 'RELEASE',
          amountMicros: remainder,
          note: 'sobra da reserva',
        },
      });
    }
    await this.prisma.broadcast.update({
      where: { id: broadcastId },
      data: { actualCostMicros: charged },
    });
  }

  /**
   * Finaliza a campanha quando não há mais pendências (chamado pelo webhook).
   * Marca COMPLETED, libera a sobra e grava o custo real.
   */
  async finalizeIfDone(broadcastId: string) {
    const b = await this.prisma.broadcast.findUnique({ where: { id: broadcastId } });
    if (!b || ['COMPLETED', 'CANCELLED'].includes(b.status)) return;
    const pending = await this.prisma.broadcastRecipient.count({
      where: {
        broadcastId,
        status: { in: ['PENDING', 'QUEUED', 'SENT'] },
      },
    });
    if (pending > 0) return;
    await this.prisma.broadcast.update({
      where: { id: broadcastId },
      data: { status: 'COMPLETED', completedAt: new Date() },
    });
    await this.releaseRemainder(b.organizationId, broadcastId);
  }
}
