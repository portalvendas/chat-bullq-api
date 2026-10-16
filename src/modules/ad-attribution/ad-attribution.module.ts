import { Module } from '@nestjs/common';
import { DashboardModule } from '../dashboard/dashboard.module';
import { AdAttributionService } from './ad-attribution.service';

@Module({
  imports: [DashboardModule],
  providers: [AdAttributionService],
  exports: [AdAttributionService],
})
export class AdAttributionModule {}
