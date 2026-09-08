import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { InstagramOAuthService } from './instagram.oauth.service';

export const INSTAGRAM_MAINTENANCE_QUEUE = 'instagram-maintenance';
const REPEAT_PATTERN = '0 4 * * *'; // todo dia 04:00 UTC
const REPEAT_JOB_ID = 'instagram-token-refresh-cron';
const JOB_NAME = 'instagram-token-refresh';

/**
 * Rotina proativa de refresh do token longo (~60d) do Instagram. Registra um
 * repeatable job diário (BullMQ, mesmo padrão do ML reconcile — sem
 * @nestjs/schedule) que renova os canais cujo token expira em <= 5 dias.
 * Idempotente: BullMQ não duplica o jobId.
 */
@Processor(INSTAGRAM_MAINTENANCE_QUEUE)
export class InstagramMaintenanceProcessor
  extends WorkerHost
  implements OnModuleInit
{
  private readonly logger = new Logger(InstagramMaintenanceProcessor.name);

  constructor(
    @InjectQueue(INSTAGRAM_MAINTENANCE_QUEUE) private readonly queue: Queue,
    private readonly oauth: InstagramOAuthService,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        JOB_NAME,
        {},
        {
          repeat: { pattern: REPEAT_PATTERN },
          jobId: REPEAT_JOB_ID,
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log(
        `Instagram token-refresh cron registrado (${REPEAT_PATTERN})`,
      );
    } catch (err: any) {
      this.logger.error(
        `Falha ao registrar cron de refresh IG: ${err?.message ?? err}`,
      );
    }
  }

  async process(_job: Job): Promise<void> {
    const r = await this.oauth.refreshExpiringSoon();
    this.logger.log(
      `Refresh IG: ${r.refreshed}/${r.checked} canais renovados`,
    );
  }
}
