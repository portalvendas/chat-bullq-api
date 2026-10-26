import { Module } from '@nestjs/common';
import { LeadDistributionService } from './lead-distribution.service';
import { LeadDistributionController } from './lead-distribution.controller';
import { LeadScopeService } from './lead-scope.service';

@Module({
  controllers: [LeadDistributionController],
  providers: [LeadDistributionService, LeadScopeService],
  exports: [LeadDistributionService, LeadScopeService],
})
export class LeadDistributionModule {}
