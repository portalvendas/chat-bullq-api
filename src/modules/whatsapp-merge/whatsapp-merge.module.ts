import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WhatsappMergeService } from './whatsapp-merge.service';
import { WhatsappMergeController } from './whatsapp-merge.controller';
import {
  WhatsappMergeSweepProcessor,
  WHATSAPP_MERGE_SWEEP_QUEUE,
} from './whatsapp-merge-sweep.processor';
import { WhatsappMergeSweepCronService } from './whatsapp-merge-sweep.cron.service';

@Module({
  imports: [BullModule.registerQueue({ name: WHATSAPP_MERGE_SWEEP_QUEUE })],
  controllers: [WhatsappMergeController],
  providers: [
    WhatsappMergeService,
    WhatsappMergeSweepProcessor,
    WhatsappMergeSweepCronService,
  ],
  exports: [WhatsappMergeService],
})
export class WhatsappMergeModule {}
