import { Module } from '@nestjs/common';
import { PublicMeController } from './controllers/public-me.controller';
import { PublicDashboardController } from './controllers/public-dashboard.controller';
import { PublicMercadoLivreController } from './controllers/public-mercadolivre.controller';
import { PublicLeadsController } from './controllers/public-leads.controller';
import { PublicLeadsService } from './services/public-leads.service';
import { DashboardModule } from '../dashboard/dashboard.module';
import { AuthModule } from '../auth/auth.module';
import { MercadoLivreModule } from '../channel-hub/adapters/mercado-livre/mercadolivre.module';
import { PipelinesModule } from '../pipelines/pipelines.module';

@Module({
  imports: [AuthModule, DashboardModule, MercadoLivreModule, PipelinesModule],
  controllers: [
    PublicMeController,
    PublicDashboardController,
    PublicMercadoLivreController,
    PublicLeadsController,
  ],
  providers: [PublicLeadsService],
})
export class PublicApiModule {}
