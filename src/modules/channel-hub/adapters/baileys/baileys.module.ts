import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { BaileysAuthStateService } from './baileys-auth-state.service';
import { BaileysMessageMapper } from './baileys.message-mapper';
import { BaileysSessionManager } from './baileys-session.manager';
import { BaileysInboundAdapter } from './baileys.inbound-adapter';
import { BaileysOutboundAdapter } from './baileys.outbound-adapter';

/**
 * WhatsApp NATIVO via Baileys (motor multi-device, QR gerado pelo próprio
 * backend do Kortia — sem provedor externo).
 *
 * ⚠️ O `BaileysSessionManager` é STATEFUL e single-instance: precisa rodar num
 * processo único (worker). Ver doc de deploy.
 */
@Module({
  imports: [BullModule.registerQueue({ name: 'inbound-messages' })],
  providers: [
    BaileysAuthStateService,
    BaileysMessageMapper,
    BaileysSessionManager,
    BaileysInboundAdapter,
    BaileysOutboundAdapter,
  ],
  exports: [
    BaileysSessionManager,
    BaileysInboundAdapter,
    BaileysOutboundAdapter,
  ],
})
export class BaileysModule {}
