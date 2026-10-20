import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { LeadWaitingService } from './lead-waiting.service';

export const LEAD_WAITING_QUEUE = 'lead-waiting';
export const LEAD_WAITING_SCAN_JOB = 'scan-waiting-leads';
const REPEAT_PATTERN = '*/5 * * * *';
const REPEAT_JOB_ID = 'lead-waiting-scan-cron';

/** Registra a varredura a cada 5 min (BullMQ repeatable, padrão do projeto). */
@Injectable()
export class LeadWaitingCron implements OnModuleInit {
  private readonly logger = new Logger(LeadWaitingCron.name);

  constructor(@InjectQueue(LEAD_WAITING_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    try {
      for (const r of await this.queue.getRepeatableJobs()) {
        if ((r.name === LEAD_WAITING_SCAN_JOB || r.id === REPEAT_JOB_ID) && r.pattern !== REPEAT_PATTERN) {
          await this.queue.removeRepeatableByKey(r.key);
        }
      }
      await this.queue.add(
        LEAD_WAITING_SCAN_JOB,
        {},
        { repeat: { pattern: REPEAT_PATTERN }, jobId: REPEAT_JOB_ID, removeOnComplete: 10, removeOnFail: 10 },
      );
    } catch (err: any) {
      this.logger.error(`Falha ao registrar varredura de leads esperando: ${err?.message ?? err}`);
    }
  }
}

@Processor(LEAD_WAITING_QUEUE, { concurrency: 1 })
export class LeadWaitingProcessor extends WorkerHost {
  constructor(private readonly service: LeadWaitingService) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== LEAD_WAITING_SCAN_JOB) return;
    await this.service.run();
  }
}
