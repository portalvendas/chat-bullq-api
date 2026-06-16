import { Module, forwardRef } from '@nestjs/common';
import { WhatsAppOfficialInboundAdapter } from './whatsapp-official.inbound-adapter';
import { WhatsAppOfficialOutboundAdapter } from './whatsapp-official.outbound-adapter';
import { WhatsAppOfficialMessageMapper } from './whatsapp-official.message-mapper';
import { WhatsAppOfficialHttpClient } from './whatsapp-official.http-client';
import { MessagingModule } from '../../../messaging/messaging.module';

@Module({
  imports: [forwardRef(() => MessagingModule)],
  providers: [
    WhatsAppOfficialInboundAdapter,
    WhatsAppOfficialOutboundAdapter,
    WhatsAppOfficialMessageMapper,
    WhatsAppOfficialHttpClient,
  ],
  exports: [
    WhatsAppOfficialInboundAdapter,
    WhatsAppOfficialOutboundAdapter,
    WhatsAppOfficialHttpClient,
  ],
})
export class WhatsAppOfficialModule {}
