import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsModule } from '../notifications/notifications.module';
import { LeadWaitingService } from './lead-waiting.service';
import { LEAD_WAITING_QUEUE, LeadWaitingCron, LeadWaitingProcessor } from './lead-waiting.cron';

/** Alerta o vendedor quando um lead fica esperando resposta humana. */
@Module({
  imports: [NotificationsModule, BullModule.registerQueue({ name: LEAD_WAITING_QUEUE })],
  providers: [LeadWaitingService, LeadWaitingCron, LeadWaitingProcessor],
  exports: [LeadWaitingService],
})
export class LeadWaitingModule {}
