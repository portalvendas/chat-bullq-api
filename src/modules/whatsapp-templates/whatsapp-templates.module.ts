import { Module } from '@nestjs/common';
import { WhatsappTemplatesService } from './whatsapp-templates.service';
import { WhatsappTemplatesController } from './whatsapp-templates.controller';

/**
 * Modelos de mensagem do WhatsApp (HSM). PrismaModule é global; o service só
 * depende dele + axios (Graph API da Meta). Exporta o service para reuso
 * futuro pelo motor de envio (texto livre dentro de 24h, template fora).
 */
@Module({
  controllers: [WhatsappTemplatesController],
  providers: [WhatsappTemplatesService],
  exports: [WhatsappTemplatesService],
})
export class WhatsappTemplatesModule {}
