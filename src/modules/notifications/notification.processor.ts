import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { RealtimeGateway } from '../realtime/realtime.gateway';

@Processor('notifications', { concurrency: 10 })
export class NotificationProcessor extends WorkerHost {
  private readonly logger = new Logger(NotificationProcessor.name);

  constructor(private readonly realtimeGateway: RealtimeGateway) {
    super();
  }

  async process(job: Job): Promise<any> {
    const { notificationId, recipientId, organizationId, type, title, body, data } = job.data;

    this.realtimeGateway.emitToUser(recipientId, 'notification:new', {
      id: notificationId,
      recipientId,
      type,
      title,
      body,
      data,
      createdAt: new Date().toISOString(),
    });

    this.logger.log(`Notification delivered via WS: ${notificationId} to user:${recipientId}`);

    return { delivered: true, channels: ['in-app'] };
  }
}
