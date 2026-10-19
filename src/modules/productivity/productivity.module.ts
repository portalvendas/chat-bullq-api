import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { CommercialRoutineModule } from '../commercial-routine/commercial-routine.module';
import { ProductivityController } from './productivity.controller';
import { ProductivityTrackingService } from './productivity-tracking.service';
import { ProductivityReportService } from './productivity-report.service';
import {
  PRODUCTIVITY_QUEUE,
  ProductivityRetentionCron,
  ProductivityRetentionProcessor,
} from './productivity-retention';

/**
 * Produtividade dos vendedores (home office): tempo de tela no CRM, início do
 * dia, atendimento (CRM + celular), funil, vendas do Tiny e rotina.
 * Painel só para OWNER/ADMIN; o heartbeat é de todo membro (só grava a si).
 */
@Module({
  imports: [CommercialRoutineModule, BullModule.registerQueue({ name: PRODUCTIVITY_QUEUE })],
  controllers: [ProductivityController],
  providers: [
    ProductivityTrackingService,
    ProductivityReportService,
    ProductivityRetentionCron,
    ProductivityRetentionProcessor,
  ],
})
export class ProductivityModule {}
