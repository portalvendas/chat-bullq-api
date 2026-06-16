import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ChannelSyncJob, ChannelSyncMode, ChannelSyncStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import { CHANNEL_SYNC_QUEUE } from './channel-sync.constants';

export interface StartSyncOptions {
  mode?: ChannelSyncMode;
  lookbackDays?: number;
}

@Injectable()
export class ChannelSyncOrchestrator {
  private readonly logger = new Logger(ChannelSyncOrchestrator.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    @InjectQueue(CHANNEL_SYNC_QUEUE) private readonly syncQueue: Queue,
  ) {}

  async start(channelId: string, options: StartSyncOptions = {}): Promise<ChannelSyncJob> {
    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) throw new NotFoundException(`Channel ${channelId} not found`);

    const adapter = this.registry.getHistorySync(channel.type);
    if (!adapter) {
      throw new BadRequestException(
        `Channel type ${channel.type} does not support history sync`,
      );
    }

    const capabilities = adapter.getSyncCapabilities();
    if (!capabilities.supportsHistoryImport) {
      throw new BadRequestException(
        `Channel type ${channel.type} adapter does not support history import`,
      );
    }

    const active = await this.prisma.channelSyncJob.findFirst({
      where: {
        channelId,
        status: { in: [ChannelSyncStatus.PENDING, ChannelSyncStatus.RUNNING] },
      },
    });
    if (active) {
      this.logger.log(`Sync already in progress for channel ${channelId} (job ${active.id})`);
      return active;
    }

    const lookbackDays = Math.min(
      options.lookbackDays ?? capabilities.defaultLookbackDays,
      capabilities.maxLookbackDays ?? Number.MAX_SAFE_INTEGER,
    );

    const job = await this.prisma.channelSyncJob.create({
      data: {
        channelId,
        status: ChannelSyncStatus.PENDING,
        mode: options.mode ?? ChannelSyncMode.INITIAL,
        lookbackDays,
      },
    });

    await this.syncQueue.add(
      'run-sync',
      { syncJobId: job.id, channelId },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(`Sync job ${job.id} enqueued for channel ${channelId}`);
    return job;
  }

  async getLatest(channelId: string): Promise<ChannelSyncJob | null> {
    return this.prisma.channelSyncJob.findFirst({
      where: { channelId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async cancel(channelId: string): Promise<ChannelSyncJob | null> {
    const active = await this.prisma.channelSyncJob.findFirst({
      where: {
        channelId,
        status: { in: [ChannelSyncStatus.PENDING, ChannelSyncStatus.RUNNING] },
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!active) return null;

    return this.prisma.channelSyncJob.update({
      where: { id: active.id },
      data: {
        status: ChannelSyncStatus.CANCELLED,
        finishedAt: new Date(),
      },
    });
  }
}
