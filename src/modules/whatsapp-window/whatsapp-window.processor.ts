import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { WhatsappWindowService, WA_WINDOW_QUEUE } from './whatsapp-window.service';

@Processor(WA_WINDOW_QUEUE, { concurrency: 1 })
export class WhatsappWindowProcessor extends WorkerHost {
  constructor(private readonly service: WhatsappWindowService) {
    super();
  }

  async process(_job: Job): Promise<{ tagged: number; untagged: number }> {
    return this.service.scan();
  }
}
