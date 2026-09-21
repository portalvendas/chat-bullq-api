import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { BroadcastStatusService } from './broadcast-status.service';
import {
  BROADCAST_RECONCILE_QUEUE,
  BROADCAST_RECONCILE_JOB,
} from './broadcast.constants';

const REPEAT_PATTERN = '*/30 * * * *'; // a cada 30 min

/** Registra o repeatable job do reconcile (padrão BullMQ do projeto). */
@Injectable()
export class BroadcastReconcileCron implements OnModuleInit {
  private readonly logger = new Logger(BroadcastReconcileCron.name);
  constructor(
    @InjectQueue(BROADCAST_RECONCILE_QUEUE) private readonly queue: Queue,
  ) {}
  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        BROADCAST_RECONCILE_JOB,
        {},
        {
          repeat: { pattern: REPEAT_PATTERN },
          jobId: 'broadcast-reconcile-cron',
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log(`broadcast_reconcile_cron_registered pattern=${REPEAT_PATTERN}`);
    } catch (err: any) {
      this.logger.error(`Falha ao registrar reconcile cron: ${err?.message ?? err}`);
    }
  }
}

@Processor(BROADCAST_RECONCILE_QUEUE, { concurrency: 1 })
export class BroadcastReconcileProcessor extends WorkerHost {
  constructor(private readonly status: BroadcastStatusService) {
    super();
  }
  async process(_job: Job): Promise<{ reconciled: number }> {
    const hours = Number(process.env.BROADCAST_RECONCILE_HOURS ?? 6);
    const reconciled = await this.status.reconcileStaleSent(hours);
    return { reconciled };
  }
}
