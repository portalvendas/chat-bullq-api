import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

const REPEAT_PATTERN = '*/15 * * * *'; // a cada 15min
const REPEAT_JOB_ID = 'ml-reconcile-cron';
export const ML_RECONCILE_JOB = 'ml-reconcile';

/**
 * Registra um repeatable job na queue `mercadolivre-inbound` que dispara a
 * reconciliação de respostas a cada 15min — mantém as perguntas atualizadas
 * quando são respondidas por outro canal (ex: vendedor respondeu no painel
 * do ML). Segue o mesmo padrão do pending-action-cron (BullMQ repeatable,
 * sem @nestjs/schedule). Idempotente: BullMQ não duplica o jobId.
 */
@Injectable()
export class MercadoLivreReconcileCronService implements OnModuleInit {
  private readonly logger = new Logger(MercadoLivreReconcileCronService.name);

  constructor(
    @InjectQueue('mercadolivre-inbound') private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        ML_RECONCILE_JOB,
        {},
        {
          repeat: { pattern: REPEAT_PATTERN },
          jobId: REPEAT_JOB_ID,
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log(`ML reconcile cron registrado (${REPEAT_PATTERN})`);
    } catch (err: any) {
      this.logger.error(
        `Falha ao registrar ML reconcile cron: ${err?.message ?? err}`,
      );
    }
  }
}
