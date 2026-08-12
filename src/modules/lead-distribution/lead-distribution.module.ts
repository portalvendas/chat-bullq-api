import { Module } from '@nestjs/common';
import { LeadDistributionService } from './lead-distribution.service';
import { LeadDistributionController } from './lead-distribution.controller';

@Module({
  controllers: [LeadDistributionController],
  providers: [LeadDistributionService],
  exports: [LeadDistributionService],
})
export class LeadDistributionModule {}
