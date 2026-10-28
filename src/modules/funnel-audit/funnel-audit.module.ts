import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LlmModule } from '../ai-agents/llm/llm.module';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { FunnelAuditController } from './funnel-audit.controller';
import { FunnelAuditService } from './funnel-audit.service';
import { FunnelAuditProcessor } from './funnel-audit.processor';
import { FunnelChecksService } from './funnel-checks.service';
import { FunnelAuditCron } from './funnel-audit.cron';
import { NotificationsModule } from '../notifications/notifications.module';
import { LeadDistributionModule } from '../lead-distribution/lead-distribution.module';
import { FUNNEL_AUDIT_QUEUE } from './funnel-audit.constants';

@Module({
  imports: [
    BullModule.registerQueue({ name: FUNNEL_AUDIT_QUEUE }),
    LlmModule,
    PipelinesModule,
    LeadDistributionModule,
    NotificationsModule,
  ],
  controllers: [FunnelAuditController],
  providers: [FunnelAuditService, FunnelAuditProcessor, FunnelChecksService, FunnelAuditCron],
  exports: [FunnelAuditService],
})
export class FunnelAuditModule {}
