import { Module } from '@nestjs/common';
import { WhatsappMergeService } from './whatsapp-merge.service';
import { WhatsappMergeController } from './whatsapp-merge.controller';

@Module({
  controllers: [WhatsappMergeController],
  providers: [WhatsappMergeService],
  exports: [WhatsappMergeService],
})
export class WhatsappMergeModule {}
