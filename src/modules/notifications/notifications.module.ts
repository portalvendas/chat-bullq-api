import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsRepository } from './notifications.repository';
import { NotificationProcessor } from './notification.processor';
import { LeadDistributionModule } from '../lead-distribution/lead-distribution.module';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'notifications' }),
    LeadDistributionModule,
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsRepository,
    NotificationProcessor,
  ],
  exports: [NotificationsService],
})
export class NotificationsModule {}
