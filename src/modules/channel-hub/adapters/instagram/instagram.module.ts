import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { InstagramInboundAdapter } from './instagram.inbound-adapter';
import { InstagramOutboundAdapter } from './instagram.outbound-adapter';
import { InstagramMessageMapper } from './instagram.message-mapper';
import { InstagramHttpClient } from './instagram.http-client';
import { InstagramSyncAdapter } from './instagram.sync-adapter';
import { InstagramContactEnricherService } from './instagram-contact-enricher.service';
import { InstagramOAuthService } from './instagram.oauth.service';
import { InstagramOAuthController } from './instagram-oauth.controller';
import {
  InstagramMaintenanceProcessor,
  INSTAGRAM_MAINTENANCE_QUEUE,
} from './instagram.maintenance.processor';

@Module({
  imports: [BullModule.registerQueue({ name: INSTAGRAM_MAINTENANCE_QUEUE })],
  controllers: [InstagramOAuthController],
  providers: [
    InstagramInboundAdapter,
    InstagramOutboundAdapter,
    InstagramMessageMapper,
    InstagramHttpClient,
    InstagramSyncAdapter,
    InstagramContactEnricherService,
    InstagramOAuthService,
    InstagramMaintenanceProcessor,
  ],
  exports: [
    InstagramInboundAdapter,
    InstagramOutboundAdapter,
    InstagramHttpClient,
    InstagramSyncAdapter,
    InstagramContactEnricherService,
    InstagramOAuthService,
  ],
})
export class InstagramModule {}
