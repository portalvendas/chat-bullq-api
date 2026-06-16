import { Module } from '@nestjs/common';
import { ZappfyInboundAdapter } from './zappfy.inbound-adapter';
import { ZappfyOutboundAdapter } from './zappfy.outbound-adapter';
import { ZappfyMessageMapper } from './zappfy.message-mapper';
import { ZappfyHttpClient } from './zappfy.http-client';
import { ZappfySyncAdapter } from './zappfy.sync-adapter';
import { ZappfyContactEnricherService } from './zappfy-contact-enricher.service';

@Module({
  providers: [
    ZappfyInboundAdapter,
    ZappfyOutboundAdapter,
    ZappfyMessageMapper,
    ZappfyHttpClient,
    ZappfySyncAdapter,
    ZappfyContactEnricherService,
  ],
  exports: [
    ZappfyInboundAdapter,
    ZappfyOutboundAdapter,
    ZappfyHttpClient,
    ZappfySyncAdapter,
    ZappfyContactEnricherService,
  ],
})
export class ZappfyModule {}
