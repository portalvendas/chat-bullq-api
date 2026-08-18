import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  WHATSAPP_MERGE_SWEEP_QUEUE,
  WHATSAPP_MERGE_SWEEP_JOB,
} from './whatsapp-merge-sweep.processor';

const REPEAT_PATTERN = '30 6 * * *'; // diário ~06:30 UTC (~03:30 BRT)
const REPEAT_JOB_ID = 'whatsapp-merge-sweep-cron';

/**
 * Registra o repeatable job diário do merge sweep. Mesmo padrão do resto do
 * projeto (BullMQ repeatable, idempotente por jobId — múltiplas instâncias
 * registram o mesmo job e o Bull mantém um só).
 */
@Injectable()
export class WhatsappMergeSweepCronService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappMergeSweepCronService.name);

  constructor(
    @InjectQueue(WHATSAPP_MERGE_SWEEP_QUEUE) private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        WHATSAPP_MERGE_SWEEP_JOB,
        {},
        {
          repeat: { pattern: REPEAT_PATTERN },
          jobId: REPEAT_JOB_ID,
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log(
        `whatsapp_merge_sweep_cron_registered pattern=${REPEAT_PATTERN}`,
      );
    } catch (err: any) {
      this.logger.error(
        `Falha ao registrar cron de merge sweep: ${err?.message ?? err}`,
      );
    }
  }
}
