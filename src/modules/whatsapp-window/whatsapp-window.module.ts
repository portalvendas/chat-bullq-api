import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WhatsappWindowService, WA_WINDOW_QUEUE } from './whatsapp-window.service';
import { WhatsappWindowProcessor } from './whatsapp-window.processor';
import { WhatsappWindowCronService } from './whatsapp-window.cron.service';

@Module({
  imports: [BullModule.registerQueue({ name: WA_WINDOW_QUEUE })],
  providers: [
    WhatsappWindowService,
    WhatsappWindowProcessor,
    WhatsappWindowCronService,
  ],
  exports: [WhatsappWindowService],
})
export class WhatsappWindowModule {}
