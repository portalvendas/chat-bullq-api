import { Module } from '@nestjs/common';
import { QuickRepliesController } from './quick-replies.controller';
import { QuickRepliesService } from './quick-replies.service';
import { QuickRepliesRepository } from './quick-replies.repository';

@Module({
  controllers: [QuickRepliesController],
  providers: [QuickRepliesRepository, QuickRepliesService],
  exports: [QuickRepliesService, QuickRepliesRepository],
})
export class QuickRepliesModule {}
