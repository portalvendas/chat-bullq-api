import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { MetaAdsController } from './meta-ads.controller';
import { MetaAdsService } from './meta-ads.service';
import { GoogleAudiencesService } from './google-audiences.service';
import { MobileDashboardService } from './mobile-dashboard.service';
import { TinyModule } from '../tiny-erp/tiny.module';

@Module({
  imports: [TinyModule],
  controllers: [DashboardController, MetaAdsController],
  providers: [DashboardService, MetaAdsService, GoogleAudiencesService, MobileDashboardService],
  exports: [DashboardService, MetaAdsService],
})
export class DashboardModule {}
