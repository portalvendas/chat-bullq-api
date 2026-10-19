import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { ProductivityTrackingService } from './productivity-tracking.service';

export const PRODUCTIVITY_QUEUE = 'productivity';
export const PRODUCTIVITY_RETENTION_JOB = 'purge-activity-minutes';
const REPEAT_PATTERN = '30 4 * * *'; // todo dia 04:30 (UTC) — fora do expediente
const REPEAT_JOB_ID = 'productivity-retention-cron';
/** Dias de histórico minuto-a-minuto mantidos (LGPD: só o necessário). */
export const ACTIVITY_RETENTION_DAYS = Number(process.env.PRODUCTIVITY_RETENTION_DAYS) || 180;

/** Registra a limpeza diária (BullMQ repeatable, mesmo padrão do projeto). */
@Injectable()
export class ProductivityRetentionCron implements OnModuleInit {
  private readonly logger = new Logger(ProductivityRetentionCron.name);

  constructor(@InjectQueue(PRODUCTIVITY_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    try {
      for (const r of await this.queue.getRepeatableJobs()) {
        if ((r.name === PRODUCTIVITY_RETENTION_JOB || r.id === REPEAT_JOB_ID) && r.pattern !== REPEAT_PATTERN) {
          await this.queue.removeRepeatableByKey(r.key);
        }
      }
      await this.queue.add(
        PRODUCTIVITY_RETENTION_JOB,
        {},
        { repeat: { pattern: REPEAT_PATTERN }, jobId: REPEAT_JOB_ID, removeOnComplete: 10, removeOnFail: 10 },
      );
    } catch (err: any) {
      this.logger.error(`Falha ao registrar limpeza de produtividade: ${err?.message ?? err}`);
    }
  }
}

@Processor(PRODUCTIVITY_QUEUE, { concurrency: 1 })
export class ProductivityRetentionProcessor extends WorkerHost {
  private readonly logger = new Logger(ProductivityRetentionProcessor.name);

  constructor(private readonly tracking: ProductivityTrackingService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== PRODUCTIVITY_RETENTION_JOB) return;
    const removed = await this.tracking.purgeOlderThan(ACTIVITY_RETENTION_DAYS);
    this.logger.log(`productivity_retention removed=${removed} keepDays=${ACTIVITY_RETENTION_DAYS}`);
  }
}
