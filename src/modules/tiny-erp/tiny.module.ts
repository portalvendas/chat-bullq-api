import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TinyController, TinyOAuthCallbackController } from './tiny.controller';
import { TinyService } from './tiny.service';
import { TinyHttpClient } from './tiny.http-client';
import { TinyCronService, TINY_QUEUE } from './tiny.cron.service';
import { TinyProcessor } from './tiny.processor';

@Module({
  imports: [BullModule.registerQueue({ name: TINY_QUEUE })],
  controllers: [TinyController, TinyOAuthCallbackController],
  providers: [TinyService, TinyHttpClient, TinyCronService, TinyProcessor],
  exports: [TinyService],
})
export class TinyModule {}
