import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LlmModule } from '../ai-agents/llm/llm.module';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { FunnelAuditController } from './funnel-audit.controller';
import { FunnelAuditService } from './funnel-audit.service';
import { FunnelAuditProcessor } from './funnel-audit.processor';
import { FUNNEL_AUDIT_QUEUE } from './funnel-audit.constants';

@Module({
  imports: [
    BullModule.registerQueue({ name: FUNNEL_AUDIT_QUEUE }),
    LlmModule,
    PipelinesModule,
  ],
  controllers: [FunnelAuditController],
  providers: [FunnelAuditService, FunnelAuditProcessor],
  exports: [FunnelAuditService],
})
export class FunnelAuditModule {}
