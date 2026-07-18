import { Module, forwardRef } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { WhatsAppOfficialInboundAdapter } from './whatsapp-official.inbound-adapter';
import { WhatsAppOfficialOutboundAdapter } from './whatsapp-official.outbound-adapter';
import { WhatsAppOfficialMessageMapper } from './whatsapp-official.message-mapper';
import { WhatsAppOfficialHttpClient } from './whatsapp-official.http-client';
import { WhatsAppCoexistenceService } from './whatsapp-coexistence.service';
import { WhatsAppEmbeddedSignupController } from './whatsapp-embedded-signup.controller';
import { MessagingModule } from '../../../messaging/messaging.module';

@Module({
  imports: [ConfigModule, forwardRef(() => MessagingModule)],
  controllers: [WhatsAppEmbeddedSignupController],
  providers: [
    WhatsAppOfficialInboundAdapter,
    WhatsAppOfficialOutboundAdapter,
    WhatsAppOfficialMessageMapper,
    WhatsAppOfficialHttpClient,
    WhatsAppCoexistenceService,
  ],
  exports: [
    WhatsAppOfficialInboundAdapter,
    WhatsAppOfficialOutboundAdapter,
    WhatsAppOfficialHttpClient,
    WhatsAppCoexistenceService,
  ],
})
export class WhatsAppOfficialModule {}
