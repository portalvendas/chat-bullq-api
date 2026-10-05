import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { LeadEnrichmentService } from './lead-enrichment.service';

export const LEAD_ENRICH_QUEUE = 'lead-enrichment';
export const LEAD_ENRICH_JOB = 'scan';

// Cadência CONTÍNUA (só leads novos/recentes): passada curta de hora em hora.
const HOURLY = { id: 'lead-enrichment-hourly', pattern: '15 * * * *', sinceDays: 2, limit: 500 };
// BACKFILL ÚNICO: varre TODOS os leads dos últimos 120 dias uma vez só.
const BACKFILL = { id: 'lead-enrichment-backfill-120d', sinceDays: 120, limit: 8000 };

interface ScanData {
  sinceDays: number;
  limit: number;
}

/**
 * Registra o enriquecimento automático:
 *  - repeatable HORÁRIO (janela de 2 dias) → mantém os leads NOVOS/recentes;
 *  - job ÚNICO de backfill (120 dias) → roda uma vez só, mesmo com re-deploys
 *    (dedup por jobId + removeOnComplete:false; só re-roda se tiver falhado).
 */
@Injectable()
export class LeadEnrichmentCron implements OnModuleInit {
  private readonly logger = new Logger(LeadEnrichmentCron.name);
  constructor(@InjectQueue(LEAD_ENRICH_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    try {
      // Limpa repeatables antigos deste job que não sejam o horário atual
      // (ex.: cadências anteriores que foram removidas).
      const existing = await this.queue.getRepeatableJobs();
      for (const r of existing) {
        if (r.name === LEAD_ENRICH_JOB && r.pattern !== HOURLY.pattern) {
          await this.queue.removeRepeatableByKey(r.key);
        }
      }
      await this.queue.add(
        LEAD_ENRICH_JOB,
        { sinceDays: HOURLY.sinceDays, limit: HOURLY.limit } as ScanData,
        {
          repeat: { pattern: HOURLY.pattern },
          jobId: HOURLY.id,
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );

      // Backfill de 120 dias: uma vez só. Se já existe (concluído/na fila), não
      // re-enfileira; se ficou como FALHO, remove e tenta de novo.
      const prev = await this.queue.getJob(BACKFILL.id);
      const prevFailed = prev ? await prev.isFailed() : false;
      if (prevFailed && prev) await prev.remove();
      if (!prev || prevFailed) {
        await this.queue.add(
          LEAD_ENRICH_JOB,
          { sinceDays: BACKFILL.sinceDays, limit: BACKFILL.limit } as ScanData,
          {
            jobId: BACKFILL.id,
            removeOnComplete: false, // mantém o registro → idempotente no restart
            removeOnFail: false,
            attempts: 1,
          },
        );
        this.logger.log('lead_enrichment_backfill_120d_enfileirado');
      }

      this.logger.log(
        `lead_enrichment_cron_registered horario=${HOURLY.pattern} (2d) + backfill_unico=120d`,
      );
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
  async process(job: Job<ScanData>): Promise<{ scanned: number; enriched: number }> {
    const sinceDays = job.data?.sinceDays ?? 2;
    const limit = job.data?.limit ?? 300;
    return this.service.enrichRecentConversations(sinceDays, limit);
  }
}
