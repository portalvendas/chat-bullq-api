import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { FunnelAuditService } from './funnel-audit.service';

export const FUNNEL_AUDIT_QUEUE = 'funnel-audit';
export const FUNNEL_AUDIT_JOB = 'run-audit';

export interface FunnelAuditJobData {
  runId: string;
  organizationId: string;
}

/**
 * Executa a auditoria de funil em background (fila BullMQ, padrão do projeto).
 * O controller só cria o run (RUNNING) e enfileira; aqui roda o trabalho pesado
 * (regras + IA) e materializa as sugestões.
 */
@Processor(FUNNEL_AUDIT_QUEUE, { concurrency: 1 })
export class FunnelAuditProcessor extends WorkerHost {
  private readonly logger = new Logger(FunnelAuditProcessor.name);

  constructor(private readonly service: FunnelAuditService) {
    super();
  }

  async process(job: Job<FunnelAuditJobData>): Promise<{ ok: boolean }> {
    const { runId, organizationId } = job.data;
    this.logger.log(`[funnel-audit] run=${runId} org=${organizationId} iniciado`);
    await this.service.executeRun(runId, organizationId);
    return { ok: true };
  }
}
