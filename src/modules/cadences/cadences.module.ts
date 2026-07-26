import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CadencesService } from './cadences.service';
import { CadencesController } from './cadences.controller';
import { CadencesProcessor } from './cadences.processor';
import { CADENCE_QUEUE } from './cadences.constants';

/**
 * Cadências (follow-up/drip). Fila `cadence` (delayed) pros passos + reuso da
 * fila `outbound-messages` pra enviar. Prisma é global.
 */
@Module({
  imports: [
    BullModule.registerQueue(
      { name: CADENCE_QUEUE },
      { name: 'outbound-messages' },
    ),
  ],
  controllers: [CadencesController],
  providers: [CadencesService, CadencesProcessor],
  exports: [CadencesService],
})
export class CadencesModule {}
