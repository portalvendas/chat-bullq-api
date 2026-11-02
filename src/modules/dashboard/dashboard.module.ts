import { Module } from '@nestjs/common';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';
import { MetaAdsController } from './meta-ads.controller';
import { MetaAdsService } from './meta-ads.service';
import { GoogleAudiencesService } from './google-audiences.service';

@Module({
  controllers: [DashboardController, MetaAdsController],
  providers: [DashboardService, MetaAdsService, GoogleAudiencesService],
  exports: [DashboardService, MetaAdsService],
})
export class DashboardModule {}
