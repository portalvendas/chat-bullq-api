import { Module } from '@nestjs/common';
import { PrismaModule } from '../../../database/prisma.module';
import { TinyModule } from '../../tiny-erp/tiny.module';
import { RecoveryOfferService } from './recovery-offer.service';

/** Núcleo leve (sem runner de IA) — importável pelo ToolsModule sem ciclo. */
@Module({
  imports: [PrismaModule, TinyModule],
  providers: [RecoveryOfferService],
  exports: [RecoveryOfferService],
})
export class ProposalRecoveryCoreModule {}
