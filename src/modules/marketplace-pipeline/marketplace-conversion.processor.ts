import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { MarketplaceConversionService } from './marketplace-conversion.service';
import { MARKETPLACE_QUEUE } from './marketplace-conversion.cron';

/**
 * Consome o repeatable job e roda o sync/conversão em todas as orgs.
 * concurrency:1 — é um cron leve; evita rodadas concorrentes competindo pela
 * mesma API de canal (rate limit).
 */
@Processor(MARKETPLACE_QUEUE, { concurrency: 1 })
export class MarketplaceConversionProcessor extends WorkerHost {
  private readonly logger = new Logger(MarketplaceConversionProcessor.name);

  constructor(private readonly conversion: MarketplaceConversionService) {
    super();
  }

  async process(_job: Job): Promise<void> {
    try {
      await this.conversion.syncAllOrgs();
    } catch (err: any) {
      this.logger.error(
        `Marketplace conversion sync falhou: ${err?.message ?? err}`,
      );
      throw err;
    }
  }
}
