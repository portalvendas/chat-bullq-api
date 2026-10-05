import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { LeadEnrichmentService } from './lead-enrichment.service';

export const LEAD_ENRICH_QUEUE = 'lead-enrichment';
export const LEAD_ENRICH_JOB = 'scan';
const REPEAT_PATTERN = '15 * * * *'; // 1x/hora (minuto 15)
const REPEAT_JOB_ID = 'lead-enrichment-scan-cron';

/** Registra o repeatable job do enriquecimento automático em lote. */
@Injectable()
export class LeadEnrichmentCron implements OnModuleInit {
  private readonly logger = new Logger(LeadEnrichmentCron.name);
  constructor(
    @InjectQueue(LEAD_ENRICH_QUEUE) private readonly queue: Queue,
  ) {}
  async onModuleInit(): Promise<void> {
    try {
      // Remove schedules antigos deste job com pattern diferente.
      const existing = await this.queue.getRepeatableJobs();
      for (const r of existing) {
        if (
          (r.name === LEAD_ENRICH_JOB || r.id === REPEAT_JOB_ID) &&
          r.pattern !== REPEAT_PATTERN
        ) {
          await this.queue.removeRepeatableByKey(r.key);
        }
      }
      await this.queue.add(
        LEAD_ENRICH_JOB,
        {},
        {
          repeat: { pattern: REPEAT_PATTERN },
          jobId: REPEAT_JOB_ID,
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log(`lead_enrichment_cron_registered pattern=${REPEAT_PATTERN}`);
    } catch (err: any) {
      this.logger.error(
        `Falha ao registrar cron de enriquecimento: ${err?.message ?? err}`,
      );
    }
  }
}

@Processor(LEAD_ENRICH_QUEUE, { concurrency: 1 })
export class LeadEnrichmentProcessor extends WorkerHost {
  constructor(private readonly service: LeadEnrichmentService) {
    super();
  }
  async process(_job: Job): Promise<{ scanned: number; enriched: number }> {
    return this.service.enrichRecentConversations();
  }
}
