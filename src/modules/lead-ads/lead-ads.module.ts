import { Module } from '@nestjs/common';
import { PipelinesModule } from '../pipelines/pipelines.module';
import { LeadAdsService } from './lead-ads.service';
import { LeadAdsController } from './lead-ads.controller';

/**
 * Facebook Leads Ads. PrismaModule e ConfigModule são globais; depende de
 * PipelinesModule pra criar o card na etapa de entrada.
 */
@Module({
  imports: [PipelinesModule],
  controllers: [LeadAdsController],
  providers: [LeadAdsService],
})
export class LeadAdsModule {}
