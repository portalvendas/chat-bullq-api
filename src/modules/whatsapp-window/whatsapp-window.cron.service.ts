import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { WA_WINDOW_QUEUE, WA_WINDOW_SCAN_JOB } from './whatsapp-window.service';

const REPEAT_PATTERN = '*/15 * * * *'; // a cada 15min
const REPEAT_JOB_ID = 'wa-window-scan-cron';

@Injectable()
export class WhatsappWindowCronService implements OnModuleInit {
  private readonly logger = new Logger(WhatsappWindowCronService.name);

  constructor(@InjectQueue(WA_WINDOW_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        WA_WINDOW_SCAN_JOB,
        {},
        {
          repeat: { pattern: REPEAT_PATTERN },
          jobId: REPEAT_JOB_ID,
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log(`wa_window_cron_registered pattern=${REPEAT_PATTERN}`);
    } catch (err: any) {
      this.logger.error(`Falha ao registrar cron da janela 24h: ${err?.message ?? err}`);
    }
  }
}
