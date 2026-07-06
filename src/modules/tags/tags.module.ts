import { Module } from '@nestjs/common';
import { TagsController } from './tags.controller';
import { TagsService } from './tags.service';
import { TagsRepository } from './tags.repository';

@Module({
  controllers: [TagsController],
  providers: [TagsRepository, TagsService],
  exports: [TagsService, TagsRepository],
})
export class TagsModule {}
