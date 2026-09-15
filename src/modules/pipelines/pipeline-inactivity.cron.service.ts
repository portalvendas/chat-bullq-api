import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  PIPELINE_INACTIVITY_QUEUE,
  PIPELINE_INACTIVITY_SCAN_JOB,
} from './pipeline-inactivity.processor';

const REPEAT_PATTERN = '*/5 * * * *'; // a cada 5min (granularidade de minutos)
const REPEAT_JOB_ID = 'pipeline-inactivity-scan-cron';

/**
 * Registra um repeatable job que dispara a varredura de cards inativos a cada
 * 5min. Mesmo padrão do resto do projeto (BullMQ repeatable, não @Cron) —
 * idempotente: múltiplas instâncias registram o mesmo jobId e o Bull mantém um.
 *
 * Antes de registrar, remove repeatables antigos deste mesmo job cujo pattern
 * mudou (ex.: o schedule antigo de 15min). Sem isso o Bull manteria os dois
 * schedules em paralelo, porque a chave do repeatable inclui o pattern.
 */
@Injectable()
export class PipelineInactivityCronService implements OnModuleInit {
  private readonly logger = new Logger(PipelineInactivityCronService.name);

  constructor(
    @InjectQueue(PIPELINE_INACTIVITY_QUEUE) private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      // Limpa schedules antigos deste job com pattern diferente do atual.
      const existing = await this.queue.getRepeatableJobs();
      for (const r of existing) {
        if (
          (r.name === PIPELINE_INACTIVITY_SCAN_JOB || r.id === REPEAT_JOB_ID) &&
          r.pattern !== REPEAT_PATTERN
        ) {
          await this.queue.removeRepeatableByKey(r.key);
          this.logger.log(
            `pipeline_inactivity_cron_stale_removed pattern=${r.pattern}`,
          );
        }
      }

      await this.queue.add(
        PIPELINE_INACTIVITY_SCAN_JOB,
        {},
        {
          repeat: { pattern: REPEAT_PATTERN },
          jobId: REPEAT_JOB_ID,
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log(
        `pipeline_inactivity_cron_registered pattern=${REPEAT_PATTERN}`,
      );
    } catch (err: any) {
      this.logger.error(
        `Falha ao registrar cron de inatividade do funil: ${err?.message ?? err}`,
      );
    }
  }
}
