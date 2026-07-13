import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MercadoLivreOAuthService } from './mercadolivre.oauth.service';
import { MercadoLivreHttpClient } from './mercadolivre.http-client';
import { MercadoLivreMessageMapper } from './mercadolivre.message-mapper';
import { MercadoLivreInboundAdapter } from './mercadolivre.inbound-adapter';
import { MercadoLivreOutboundAdapter } from './mercadolivre.outbound-adapter';
import { MercadoLivreQuestionsProcessor } from './mercadolivre.questions.processor';
import { MercadoLivreProductsService } from './mercadolivre.products.service';
import { MercadoLivreWebhookController } from './mercadolivre-webhook.controller';
import { MercadoLivreOAuthController } from './mercadolivre-oauth.controller';
import { WebhookEventsService } from '../../webhook-events.service';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: 'mercadolivre-inbound' },
      { name: 'inbound-messages' },
    ),
  ],
  controllers: [MercadoLivreWebhookController, MercadoLivreOAuthController],
  providers: [
    MercadoLivreOAuthService,
    MercadoLivreHttpClient,
    MercadoLivreMessageMapper,
    MercadoLivreInboundAdapter,
    MercadoLivreOutboundAdapter,
    MercadoLivreQuestionsProcessor,
    MercadoLivreProductsService,
    // Instância local (evita ciclo channel-hub↔ML). Stateless, só usa Prisma
    // (global). Dá ao webhook/processor do ML o mesmo log de replay dos
    // canais genéricos.
    WebhookEventsService,
  ],
  exports: [
    MercadoLivreInboundAdapter,
    MercadoLivreOutboundAdapter,
    MercadoLivreHttpClient,
    MercadoLivreProductsService,
  ],
})
export class MercadoLivreModule {}
