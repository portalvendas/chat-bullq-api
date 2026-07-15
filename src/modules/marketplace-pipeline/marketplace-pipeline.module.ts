import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MercadoLivreModule } from '../channel-hub/adapters/mercado-livre/mercadolivre.module';
import { ShopeeModule } from '../channel-hub/adapters/shopee/shopee.module';
import { MarketplaceOrdersService } from './marketplace-orders.service';
import { MarketplaceConversionService } from './marketplace-conversion.service';
import { MarketplaceConversionCron, MARKETPLACE_QUEUE } from './marketplace-conversion.cron';
import { MarketplaceConversionProcessor } from './marketplace-conversion.processor';
import { MarketplacePipelineController } from './marketplace-pipeline.controller';

/**
 * Funil de Marketplace com conversão automática. Reaproveita os http-clients
 * autenticados do ML e da Shopee (exportados pelos respectivos módulos) pra
 * consultar pedidos. Prisma e RealtimeGateway são globais.
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: MARKETPLACE_QUEUE }),
    MercadoLivreModule,
    ShopeeModule,
  ],
  controllers: [MarketplacePipelineController],
  providers: [
    MarketplaceOrdersService,
    MarketplaceConversionService,
    MarketplaceConversionCron,
    MarketplaceConversionProcessor,
  ],
  exports: [MarketplaceConversionService],
})
export class MarketplacePipelineModule {}
