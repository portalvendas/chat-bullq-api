import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { MetaAdsController } from './meta-ads.controller';
import { MetaAdsService } from './meta-ads.service';
import { GoogleAudiencesService } from './google-audiences.service';
import { MobileDashboardService } from './mobile-dashboard.service';
import { AdsPerformanceService } from './ads-performance.service';
import { TinyModule } from '../tiny-erp/tiny.module';

@Module({
  imports: [TinyModule],
  controllers: [DashboardController, MetaAdsController],
  providers: [DashboardService, MetaAdsService, GoogleAudiencesService, MobileDashboardService, AdsPerformanceService],
  exports: [DashboardService, MetaAdsService],
})
export class DashboardModule {}
