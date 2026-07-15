import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ShopeeOAuthService } from './shopee.oauth.service';
import { ShopeeHttpClient } from './shopee.http-client';
import { ShopeeOAuthController } from './shopee-oauth.controller';

/**
 * Adapter Shopee (marketplace, Open Platform API v2). Fase 1: fundação de
 * auth (assinatura HMAC + OAuth + refresh). Próximas fases: OAuth controller,
 * webhook (push nível partner, roteia por shop_id), processor de mensagens
 * do comprador (Shopee Chat) e outbound (send_message), mais o adapter
 * inbound/outbound registrado no ChannelAdapterRegistry.
 */
@Module({
  imports: [ConfigModule],
  controllers: [ShopeeOAuthController],
  providers: [ShopeeOAuthService, ShopeeHttpClient],
  exports: [ShopeeOAuthService, ShopeeHttpClient],
})
export class ShopeeModule {}
