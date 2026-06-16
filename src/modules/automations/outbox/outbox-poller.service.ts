import {
  Injectable,
  Logger,
  OnModuleInit,
  OnModuleDestroy,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { randomUUID } from 'crypto';
import { OutboxEventStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { KillSwitchService } from '../kill-switch.service';
import {
  AUTOMATION_QUEUE,
  OUTBOX_POLL_BATCH_SIZE,
  OUTBOX_POLL_INTERVAL_MS,
  OUTBOX_LEASE_TTL_MS,
} from '../automations.constants';
import { AutomationJobData } from '../automations.types';

// The poller is the bridge from "row in Postgres" to "job on BullMQ".
//
// Why a poller (and not LISTEN/NOTIFY or a direct queue push)?
//   1. Direct queue push from inside the transaction is tempting but
//      unsafe — if the TX commits AND the BullMQ push fails (Redis blip),
//      we lose the event. With the outbox, the row is durable and the
//      poller retries until success.
//   2. LISTEN/NOTIFY would couple us to Postgres-specific plumbing and
//      doesn't survive Postgres restarts.
//
// Concurrency: multiple API replicas all run pollers. We use a "claim-
// then-process" pattern with a `leased_by` token + `leased_until` so two
// pollers don't fight over the same row. Lease expiration unjams
// crashed workers.
@Injectable()
export class OutboxPollerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxPollerService.name);
  private readonly workerId = `poller-${process.pid}-${randomUUID().slice(0, 8)}`;
  private timer: NodeJS.Timeout | null = null;
  private inFlight = false;
  private stopping = false;

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue(AUTOMATION_QUEUE) private readonly queue: Queue,
    private readonly killSwitch: KillSwitchService,
  ) {}

  onModuleInit() {
    this.scheduleNext();
    this.logger.log(`Outbox poller started as ${this.workerId}`);
  }

  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    // Brief grace so the in-flight tick completes before pod termination.
    // Anything beyond this is on Kubernetes' grace period — nothing we
    // do here should block longer than that.
    if (this.inFlight) {
      await new Promise((r) => setTimeout(r, 200));
    }
  }

  private scheduleNext() {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext());
    }, OUTBOX_POLL_INTERVAL_MS);
  }

  private async tick(): Promise<void> {
    if (this.inFlight) return;
    this.inFlight = true;
    try {
      const claimed = await this.claimBatch();
      if (claimed.length === 0) return;

      // Kill switch path: drain events without scheduling jobs. This is
      // what protects prod from PR 1 — listener emits, but execution is
      // off, so events just disappear cleanly with a marker.
      if (!this.killSwitch.isEnabled()) {
        await this.prisma.outboxEvent.updateMany({
          where: { id: { in: claimed.map((e) => e.id) } },
          data: {
            status: OutboxEventStatus.PROCESSED,
            processedAt: new Date(),
            lastError: 'kill_switch_disabled',
          },
        });
        return;
      }

      // Hot path: enqueue jobs for the worker. We push sequentially so a
      // BullMQ outage marks remaining events back to PENDING for the next
      // tick — no event is "lost in flight".
      for (const event of claimed) {
        try {
          const job: AutomationJobData = {
            outboxEventId: event.id,
            organizationId: event.organizationId,
            trigger: event.trigger,
            payload: event.payload as unknown as AutomationJobData['payload'],
            traceId: event.traceId,
            cascadeDepth: event.cascadeDepth,
            visitedAutomations: [],
          };
          await this.queue.add('automation-event', job, {
            jobId: event.id, // BullMQ-side dedup
            removeOnComplete: { age: 3_600, count: 1_000 },
            removeOnFail: { age: 86_400, count: 5_000 },
            attempts: 3,
            backoff: { type: 'exponential', delay: 2_000 },
          });
        } catch (err) {
          // Couldn't enqueue → release the lease so another tick can retry.
          this.logger.error(
            `Failed to enqueue outbox event ${event.id}: ${(err as Error).message}`,
          );
          await this.prisma.outboxEvent.updateMany({
            where: { id: event.id, leasedBy: this.workerId },
            data: {
              status: OutboxEventStatus.PENDING,
              leasedBy: null,
              leasedUntil: null,
              attemptCount: { increment: 1 },
              lastError: (err as Error).message.slice(0, 500),
            },
          });
        }
      }
    } catch (err) {
      this.logger.error(`Outbox tick failed: ${(err as Error).message}`);
    } finally {
      this.inFlight = false;
    }
  }

  // Atomic claim: pick PENDING rows OR rows with expired leases (crashed
  // workers), set status=PROCESSING + lease, return them. The
  // `FOR UPDATE SKIP LOCKED` guarantees N pollers don't grab the same row.
  private async claimBatch() {
    const now = new Date();
    const leaseUntil = new Date(now.getTime() + OUTBOX_LEASE_TTL_MS);

    return this.prisma.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<
        Array<{ id: string }>
      >(Prisma.sql`
        SELECT id FROM "outbox_events"
        WHERE (
          "status" = 'PENDING'
          OR ("status" = 'PROCESSING' AND "leased_until" < ${now})
        )
        ORDER BY "created_at" ASC
        LIMIT ${OUTBOX_POLL_BATCH_SIZE}
        FOR UPDATE SKIP LOCKED
      `);

      if (candidates.length === 0) return [];

      const ids = candidates.map((c) => c.id);
      await tx.outboxEvent.updateMany({
        where: { id: { in: ids } },
        data: {
          status: OutboxEventStatus.PROCESSING,
          leasedBy: this.workerId,
          leasedUntil: leaseUntil,
          attemptCount: { increment: 1 },
        },
      });

      return tx.outboxEvent.findMany({
        where: { id: { in: ids } },
      });
    });
  }
}
