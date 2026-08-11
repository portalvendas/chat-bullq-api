import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

export const TINY_QUEUE = 'tiny-sync';
export const TINY_SYNC_JOB = 'tiny-sync-all';

const REPEAT_PATTERN = '*/15 * * * *'; // a cada 15min
const REPEAT_JOB_ID = 'tiny-sync-cron';

/** Registra o job repetível que dispara o sync incremental do Tiny. */
@Injectable()
export class TinyCronService implements OnModuleInit {
  private readonly logger = new Logger(TinyCronService.name);

  constructor(@InjectQueue(TINY_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        TINY_SYNC_JOB,
        {},
        {
          repeat: { pattern: REPEAT_PATTERN },
          jobId: REPEAT_JOB_ID,
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log(`tiny_sync_cron_registered pattern=${REPEAT_PATTERN}`);
    } catch (err: any) {
      this.logger.error(`Falha ao registrar cron do Tiny: ${err?.message ?? err}`);
    }
  }
}
