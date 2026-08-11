import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TinyController, TinyOAuthCallbackController } from './tiny.controller';
import { TinyService } from './tiny.service';
import { TinyHttpClient } from './tiny.http-client';
import { TinyCronService, TINY_QUEUE } from './tiny.cron.service';
import { TinyProcessor } from './tiny.processor';
import { MetaCapiService } from './meta-capi/meta-capi.service';
import { MetaCapiHttpClient } from './meta-capi/meta-capi.http-client';

@Module({
  imports: [BullModule.registerQueue({ name: TINY_QUEUE })],
  controllers: [TinyController, TinyOAuthCallbackController],
  providers: [
    TinyService,
    TinyHttpClient,
    TinyCronService,
    TinyProcessor,
    MetaCapiService,
    MetaCapiHttpClient,
  ],
  exports: [TinyService, MetaCapiService],
})
export class TinyModule {}
