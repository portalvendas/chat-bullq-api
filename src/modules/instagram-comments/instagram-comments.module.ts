import { Module } from '@nestjs/common';
import { InstagramCommentsService } from './instagram-comments.service';
import { InstagramCommentsController } from './instagram-comments.controller';
import { InstagramModule } from '../channel-hub/adapters/instagram/instagram.module';
import { PipelinesModule } from '../pipelines/pipelines.module';

@Module({
  imports: [InstagramModule, PipelinesModule],
  controllers: [InstagramCommentsController],
  providers: [InstagramCommentsService],
  exports: [InstagramCommentsService],
})
export class InstagramCommentsModule {}
