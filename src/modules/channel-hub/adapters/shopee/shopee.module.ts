import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ShopeeOAuthService } from './shopee.oauth.service';
import { ShopeeHttpClient } from './shopee.http-client';
import { ShopeeMessageMapper } from './shopee.message-mapper';
import { ShopeeInboundAdapter } from './shopee.inbound-adapter';
import { ShopeeOutboundAdapter } from './shopee.outbound-adapter';
import { ShopeeMessagesProcessor } from './shopee.messages.processor';
import { ShopeeOAuthController } from './shopee-oauth.controller';
import { ShopeeWebhookController } from './shopee-webhook.controller';
import { WebhookEventsService } from '../../webhook-events.service';

/**
 * Adapter Shopee (marketplace, Open Platform API v2). Fase 1: chat do comprador.
 * - Auth: assinatura HMAC + OAuth + refresh (ShopeeOAuthService/HttpClient).
 * - Recebimento: webhook (push nível partner, roteia por shop_id) →
 *   fila `shopee-inbound` → ShopeeMessagesProcessor → `inbound-messages`.
 * - Envio: ShopeeOutboundAdapter via sellerchat/send_message.
 * O par inbound/outbound é registrado no ChannelAdapterRegistry pelo channel-hub.
 */
@Module({
  imports: [
    ConfigModule,
    BullModule.registerQueue(
      { name: 'shopee-inbound' },
      { name: 'inbound-messages' },
    ),
  ],
  controllers: [ShopeeOAuthController, ShopeeWebhookController],
  providers: [
    ShopeeOAuthService,
    ShopeeHttpClient,
    ShopeeMessageMapper,
    ShopeeInboundAdapter,
    ShopeeOutboundAdapter,
    ShopeeMessagesProcessor,
    // Instância local (mesmo padrão do ML) — log de replay dos webhooks.
    WebhookEventsService,
  ],
  exports: [
    ShopeeOAuthService,
    ShopeeHttpClient,
    ShopeeInboundAdapter,
    ShopeeOutboundAdapter,
  ],
})
export class ShopeeModule {}
