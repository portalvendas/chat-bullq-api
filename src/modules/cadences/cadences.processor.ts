import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { CadencesService } from './cadences.service';
import { CADENCE_QUEUE } from './cadences.constants';

interface CadenceStepJob {
  runId: string;
  stepIndex: number;
}

/** Consome os passos agendados (delayed) e delega a lógica ao service. */
@Processor(CADENCE_QUEUE, { concurrency: 5 })
export class CadencesProcessor extends WorkerHost {
  private readonly logger = new Logger(CadencesProcessor.name);

  constructor(private readonly service: CadencesService) {
    super();
  }

  async process(job: Job<CadenceStepJob>): Promise<void> {
    const { runId, stepIndex } = job.data;
    try {
      await this.service.runStep(runId, stepIndex);
    } catch (err: any) {
      this.logger.error(
        `Passo ${stepIndex} da cadência (run ${runId}) falhou: ${err?.message ?? err}`,
      );
      throw err;
    }
  }
}
