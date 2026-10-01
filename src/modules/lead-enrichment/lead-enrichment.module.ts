import { Module } from '@nestjs/common';
import { LeadEnrichmentService } from './lead-enrichment.service';
import { LeadEnrichmentController } from './lead-enrichment.controller';

@Module({
  controllers: [LeadEnrichmentController],
  providers: [LeadEnrichmentService],
  exports: [LeadEnrichmentService],
})
export class LeadEnrichmentModule {}
