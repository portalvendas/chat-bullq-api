import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { LeadEnrichmentService } from './lead-enrichment.service';
import { LeadEnrichmentController } from './lead-enrichment.controller';
import {
  LEAD_ENRICH_QUEUE,
  LeadEnrichmentCron,
  LeadEnrichmentProcessor,
} from './lead-enrichment.cron';

@Module({
  imports: [BullModule.registerQueue({ name: LEAD_ENRICH_QUEUE })],
  controllers: [LeadEnrichmentController],
  providers: [
    LeadEnrichmentService,
    LeadEnrichmentCron,
    LeadEnrichmentProcessor,
  ],
  exports: [LeadEnrichmentService],
})
export class LeadEnrichmentModule {}
