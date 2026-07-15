import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

export const MARKETPLACE_QUEUE = 'marketplace-pipeline';
export const MARKETPLACE_SYNC_JOB = 'marketplace-conversion-sync';
const REPEAT_PATTERN = '*/30 * * * *'; // a cada 30min
const REPEAT_JOB_ID = 'marketplace-conversion-cron';

/**
 * Registra o repeatable job que dispara a sincronização/conversão do funil de
 * marketplace a cada 30min. Mesmo padrão do ML reconcile cron (BullMQ
 * repeatable, idempotente por jobId — não duplica entre restarts/instâncias).
 */
@Injectable()
export class MarketplaceConversionCron implements OnModuleInit {
  private readonly logger = new Logger(MarketplaceConversionCron.name);

  constructor(
    @InjectQueue(MARKETPLACE_QUEUE) private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        MARKETPLACE_SYNC_JOB,
        {},
        {
          repeat: { pattern: REPEAT_PATTERN },
          jobId: REPEAT_JOB_ID,
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log(`Marketplace conversion cron registrado (${REPEAT_PATTERN})`);
    } catch (err: any) {
      this.logger.error(
        `Falha ao registrar marketplace conversion cron: ${err?.message ?? err}`,
      );
    }
  }
}
