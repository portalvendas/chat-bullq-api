import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PipelinesController } from './pipelines.controller';
import { PipelinesService } from './pipelines.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { NotificationsModule } from '../notifications/notifications.module';
import {
  PipelineInactivityProcessor,
  PIPELINE_INACTIVITY_QUEUE,
} from './pipeline-inactivity.processor';
import { PipelineInactivityCronService } from './pipeline-inactivity.cron.service';

@Module({
  imports: [
    RealtimeModule,
    NotificationsModule,
    BullModule.registerQueue({ name: PIPELINE_INACTIVITY_QUEUE }),
  ],
  controllers: [PipelinesController],
  providers: [
    PipelinesService,
    PipelineInactivityProcessor,
    PipelineInactivityCronService,
  ],
  exports: [PipelinesService],
})
export class PipelinesModule {}
