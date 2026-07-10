import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MercadoLivreOAuthService } from './mercadolivre.oauth.service';
import { MercadoLivreHttpClient } from './mercadolivre.http-client';
import { MercadoLivreMessageMapper } from './mercadolivre.message-mapper';
import { MercadoLivreInboundAdapter } from './mercadolivre.inbound-adapter';
import { MercadoLivreOutboundAdapter } from './mercadolivre.outbound-adapter';
import { MercadoLivreQuestionsProcessor } from './mercadolivre.questions.processor';
import { MercadoLivreWebhookController } from './mercadolivre-webhook.controller';
import { MercadoLivreOAuthController } from './mercadolivre-oauth.controller';

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
  ],
  exports: [MercadoLivreInboundAdapter, MercadoLivreOutboundAdapter],
})
export class MercadoLivreModule {}
