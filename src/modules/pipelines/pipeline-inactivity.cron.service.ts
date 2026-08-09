import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  PIPELINE_INACTIVITY_QUEUE,
  PIPELINE_INACTIVITY_SCAN_JOB,
} from './pipeline-inactivity.processor';

const REPEAT_PATTERN = '*/15 * * * *'; // a cada 15min
const REPEAT_JOB_ID = 'pipeline-inactivity-scan-cron';

/**
 * Registra um repeatable job que dispara a varredura de cards inativos a cada
 * 15min. Mesmo padrão do resto do projeto (BullMQ repeatable, não @Cron) —
 * idempotente: múltiplas instâncias registram o mesmo jobId e o Bull mantém um.
 */
@Injectable()
export class PipelineInactivityCronService implements OnModuleInit {
  private readonly logger = new Logger(PipelineInactivityCronService.name);

  constructor(
    @InjectQueue(PIPELINE_INACTIVITY_QUEUE) private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
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
