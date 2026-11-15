import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Job, Queue } from 'bullmq';
import { ProposalRecoveryService } from './proposal-recovery.service';
import { PROPOSAL_RECOVERY_QUEUE, PROPOSAL_RECOVERY_SCAN_JOB } from './proposal-recovery.constants';

const REPEAT_PATTERN = '*/15 * * * *';
const REPEAT_JOB_ID = 'proposal-recovery-cron';

/** Registra o job repetível (a cada 15 min). */
@Injectable()
export class ProposalRecoveryCron implements OnModuleInit {
  private readonly logger = new Logger(ProposalRecoveryCron.name);
  constructor(@InjectQueue(PROPOSAL_RECOVERY_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        PROPOSAL_RECOVERY_SCAN_JOB,
        {},
        { repeat: { pattern: REPEAT_PATTERN }, jobId: REPEAT_JOB_ID, removeOnComplete: 10, removeOnFail: 20 },
      );
      this.logger.log(`proposal_recovery_cron_registered pattern=${REPEAT_PATTERN}`);
    } catch (err: any) {
      this.logger.error(`Falha ao registrar cron de recuperação: ${err?.message ?? err}`);
    }
  }
}

/** Concorrência 1: dois scans simultâneos nunca disputam o mesmo candidato. */
@Processor(PROPOSAL_RECOVERY_QUEUE, { concurrency: 1 })
export class ProposalRecoveryProcessor extends WorkerHost {
  constructor(private readonly service: ProposalRecoveryService) {
    super();
  }
  async process(_job: Job) {
    return this.service.scan();
  }
}
