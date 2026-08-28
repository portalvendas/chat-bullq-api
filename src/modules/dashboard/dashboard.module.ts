import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { MetaAdsController } from './meta-ads.controller';
import { MetaAdsService } from './meta-ads.service';

@Module({
  controllers: [DashboardController, MetaAdsController],
  providers: [DashboardService, MetaAdsService],
  exports: [DashboardService, MetaAdsService],
})
export class DashboardModule {}
