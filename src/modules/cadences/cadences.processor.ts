import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import type { Job } from 'bullmq';
import { CadencesService } from './cadences.service';
import { CADENCE_QUEUE } from './cadences.constants';

interface CadenceJob {
  runId: string;
  // motor de grafo
  nodeId?: string;
  kind?: 'advance' | 'timeout';
  // legado linear (jobs em voo de antes do deploy)
  stepIndex?: number;
}

/**
 * Consome os jobs da fila de salesbots e delega ao service.
 *  - kind 'advance' → caminha pelo grafo a partir do nó
 *  - kind 'timeout' → cronômetro de um nó de espera estourou
 *  - stepIndex      → LEGADO (régua linear ainda em voo)
 */
@Processor(CADENCE_QUEUE, { concurrency: 5 })
export class CadencesProcessor extends WorkerHost {
  private readonly logger = new Logger(CadencesProcessor.name);

  constructor(private readonly service: CadencesService) {
    super();
  }

  async process(job: Job<CadenceJob>): Promise<void> {
    const { runId, nodeId, kind, stepIndex } = job.data;
    try {
      if (typeof stepIndex === 'number' && !kind) {
        await this.service.runStep(runId, stepIndex); // legado
      } else if (kind === 'timeout' && nodeId) {
        await this.service.onTimeout(runId, nodeId);
      } else if (nodeId) {
        await this.service.advance(runId, nodeId);
      } else {
        this.logger.warn(`Job de salesbot sem alvo (run ${runId})`);
      }
    } catch (err: any) {
      this.logger.error(
        `Job de salesbot (run ${runId}, ${kind ?? 'step'}) falhou: ${err?.message ?? err}`,
      );
      throw err;
    }
  }
}
