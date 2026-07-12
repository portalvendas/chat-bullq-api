import { Module } from '@nestjs/common';
import { PublicMeController } from './controllers/public-me.controller';
import { PublicDashboardController } from './controllers/public-dashboard.controller';
import { PublicMercadoLivreController } from './controllers/public-mercadolivre.controller';
import { DashboardModule } from '../dashboard/dashboard.module';
import { AuthModule } from '../auth/auth.module';
import { MercadoLivreModule } from '../channel-hub/adapters/mercado-livre/mercadolivre.module';

@Module({
  imports: [AuthModule, DashboardModule, MercadoLivreModule],
  controllers: [PublicMeController, PublicDashboardController, PublicMercadoLivreController],
})
export class PublicApiModule {}
