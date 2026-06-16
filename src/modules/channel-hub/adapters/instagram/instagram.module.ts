import { Module } from '@nestjs/common';
import { InstagramInboundAdapter } from './instagram.inbound-adapter';
import { InstagramOutboundAdapter } from './instagram.outbound-adapter';
import { InstagramMessageMapper } from './instagram.message-mapper';
import { InstagramHttpClient } from './instagram.http-client';
import { InstagramSyncAdapter } from './instagram.sync-adapter';
import { InstagramContactEnricherService } from './instagram-contact-enricher.service';

@Module({
  providers: [
    InstagramInboundAdapter,
    InstagramOutboundAdapter,
    InstagramMessageMapper,
    InstagramHttpClient,
    InstagramSyncAdapter,
    InstagramContactEnricherService,
  ],
  exports: [
    InstagramInboundAdapter,
    InstagramOutboundAdapter,
    InstagramHttpClient,
    InstagramSyncAdapter,
    InstagramContactEnricherService,
  ],
})
export class InstagramModule {}
