import { Module } from '@nestjs/common';
import { ZApiInboundAdapter } from './zapi.inbound-adapter';
import { ZApiOutboundAdapter } from './zapi.outbound-adapter';
import { ZApiMessageMapper } from './zapi.message-mapper';
import { ZApiHttpClient } from './zapi.http-client';

@Module({
  providers: [
    ZApiInboundAdapter,
    ZApiOutboundAdapter,
    ZApiMessageMapper,
    ZApiHttpClient,
  ],
  exports: [ZApiInboundAdapter, ZApiOutboundAdapter, ZApiHttpClient],
})
export class ZApiModule {}
