import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { TinyController, TinyOAuthCallbackController } from './tiny.controller';
import { TinyService } from './tiny.service';
import { TinyReceiptsService } from './tiny-receipts.service';
import { TinyHttpClient } from './tiny.http-client';
import { TinyCronService, TINY_QUEUE } from './tiny.cron.service';
import { TinyProcessor } from './tiny.processor';
import { MetaCapiService } from './meta-capi/meta-capi.service';
import { MetaCapiHttpClient } from './meta-capi/meta-capi.http-client';
import { MetaCapiLeadsService } from './meta-capi/meta-capi-leads.service';
import { TinySyncMonitorService } from './tiny-sync-monitor.service';
import { LlmModule } from '../ai-agents/llm/llm.module';
import { UploadsService } from '../messaging/messages/uploads.service';
import { LeadDistributionModule } from '../lead-distribution/lead-distribution.module';
import { UnassignedLeadsService } from './unassigned-leads.service';

@Module({
  imports: [BullModule.registerQueue({ name: TINY_QUEUE }), LlmModule, LeadDistributionModule],
  controllers: [TinyController, TinyOAuthCallbackController],
  providers: [
    TinyService,
    TinyReceiptsService,
    TinyHttpClient,
    TinyCronService,
    TinyProcessor,
    MetaCapiService,
    MetaCapiHttpClient,
    MetaCapiLeadsService,
    TinySyncMonitorService,
    UnassignedLeadsService,
    // UploadsService é standalone (só depende de ConfigService global) — provê
    // uma instância local pra salvar os arquivos de comprovante.
    UploadsService,
  ],
  exports: [TinyService, MetaCapiService],
})
export class TinyModule {}
