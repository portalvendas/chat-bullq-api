import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { Channel, ChannelSyncStatus } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { HistoryImportService } from '../../messaging/pipeline/history-import.service';
import { HistorySyncPort } from '../ports/history-sync.port';
import {
  HistorySyncFilters,
  NormalizedHistoricalConversation,
} from '../ports/types';
import { CHANNEL_SYNC_QUEUE } from './channel-sync.constants';

interface SyncJobData {
  syncJobId: string;
  channelId: string;
}

const CONVERSATION_PAGE_SIZE = 50;
const MESSAGE_PAGE_SIZE = 50;
const MAX_CONVERSATIONS = 1000;
const MAX_MESSAGES_PER_CONVERSATION = 500;
const REQUEST_DELAY_MS = 400;
const RATE_LIMIT_BACKOFF_MS = 60_000;
const MAX_RATE_LIMIT_RETRIES = 3;

@Processor(CHANNEL_SYNC_QUEUE, { concurrency: 1 })
export class ChannelSyncProcessor extends WorkerHost {
  private readonly logger = new Logger(ChannelSyncProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ChannelAdapterRegistry,
    private readonly realtimeGateway: RealtimeGateway,
    private readonly importer: HistoryImportService,
  ) {
    super();
  }

  async process(job: Job<SyncJobData>): Promise<any> {
    const { syncJobId, channelId } = job.data;

    const syncJob = await this.prisma.channelSyncJob.findUnique({
      where: { id: syncJobId },
    });
    if (!syncJob) {
      this.logger.warn(`Sync job ${syncJobId} not found — aborting`);
      return;
    }
    if (syncJob.status === ChannelSyncStatus.CANCELLED) {
      this.logger.log(`Sync job ${syncJobId} cancelled — aborting`);
      return;
    }

    const channel = await this.prisma.channel.findUnique({ where: { id: channelId } });
    if (!channel) {
      await this.markFailed(syncJobId, 'Channel not found');
      return;
    }

    const adapter = this.registry.getHistorySync(channel.type);
    if (!adapter) {
      await this.markFailed(syncJobId, `No history sync adapter for ${channel.type}`);
      return;
    }

    await this.prisma.channelSyncJob.update({
      where: { id: syncJobId },
      data: { status: ChannelSyncStatus.RUNNING, startedAt: new Date() },
    });
    this.emitProgress(channel.organizationId, syncJobId, channelId, {
      status: ChannelSyncStatus.RUNNING,
      phase: 'starting',
    });

    const filters: HistorySyncFilters = {
      sinceTimestamp: new Date(Date.now() - syncJob.lookbackDays * 24 * 60 * 60 * 1000),
    };

    try {
      const conversations = await this.collectConversations(channel, adapter, filters);
      await this.prisma.channelSyncJob.update({
        where: { id: syncJobId },
        data: { conversationsTotal: conversations.length },
      });
      this.emitProgress(channel.organizationId, syncJobId, channelId, {
        status: ChannelSyncStatus.RUNNING,
        phase: 'importing',
        conversationsTotal: conversations.length,
      });

      let convImported = 0;
      let msgImported = 0;
      let contactsImported = 0;
      const seenContactIds = new Set<string>();

      for (const conv of conversations) {
        const cancelled = await this.isCancelled(syncJobId);
        if (cancelled) break;

        try {
          const importResult = await this.importer.importConversation(channel, conv);
          convImported++;
          if (!seenContactIds.has(importResult.contactId)) {
            seenContactIds.add(importResult.contactId);
            if (importResult.isNew) contactsImported++;
          }

          const msgResult = await this.importConversationMessages(
            channel,
            adapter,
            conv.externalConversationId,
            importResult.conversationId,
            filters,
          );
          msgImported += msgResult;

          if (msgResult > 0) {
            await this.importer.notifyConversationImported(
              channel.organizationId,
              importResult.conversationId,
            );
          }

          await this.prisma.channelSyncJob.update({
            where: { id: syncJobId },
            data: {
              conversationsImported: convImported,
              messagesImported: msgImported,
              contactsImported,
            },
          });

          if (convImported % 5 === 0 || convImported === conversations.length) {
            this.emitProgress(channel.organizationId, syncJobId, channelId, {
              status: ChannelSyncStatus.RUNNING,
              phase: 'importing',
              conversationsTotal: conversations.length,
              conversationsImported: convImported,
              messagesImported: msgImported,
              contactsImported,
            });
          }
        } catch (err: any) {
          this.logger.warn(
            `Failed to import conversation ${conv.externalConversationId}: ${err.message}`,
          );
        }
      }

      await this.prisma.channelSyncJob.update({
        where: { id: syncJobId },
        data: {
          status: ChannelSyncStatus.COMPLETED,
          finishedAt: new Date(),
          conversationsImported: convImported,
          messagesImported: msgImported,
          contactsImported,
        },
      });
      this.emitProgress(channel.organizationId, syncJobId, channelId, {
        status: ChannelSyncStatus.COMPLETED,
        phase: 'done',
        conversationsTotal: conversations.length,
        conversationsImported: convImported,
        messagesImported: msgImported,
        contactsImported,
      });

      this.logger.log(
        `Sync ${syncJobId} complete: ${convImported}/${conversations.length} conversations, ${msgImported} messages`,
      );
    } catch (err: any) {
      this.logger.error(`Sync ${syncJobId} failed: ${err.message}`, err.stack);
      await this.markFailed(syncJobId, err.message);
      this.emitProgress(channel.organizationId, syncJobId, channelId, {
        status: ChannelSyncStatus.FAILED,
        phase: 'failed',
        errorMessage: err.message,
      });
      throw err;
    }
  }

  private async collectConversations(
    channel: Channel,
    adapter: HistorySyncPort,
    filters: HistorySyncFilters,
  ): Promise<NormalizedHistoricalConversation[]> {
    const all: NormalizedHistoricalConversation[] = [];
    let cursor: string | undefined;
    do {
      const result = await this.withRateLimit(() =>
        adapter.fetchConversations(channel, filters, cursor, CONVERSATION_PAGE_SIZE),
      );
      all.push(...result.conversations);
      cursor = result.nextCursor;
      if (all.length >= MAX_CONVERSATIONS) break;
      await this.sleep(REQUEST_DELAY_MS);
    } while (cursor);
    return all;
  }

  private async importConversationMessages(
    channel: Channel,
    adapter: HistorySyncPort,
    externalConversationId: string,
    conversationId: string,
    filters: HistorySyncFilters,
  ): Promise<number> {
    let cursor: string | undefined;
    let imported = 0;
    do {
      const result = await this.withRateLimit(() =>
        adapter.fetchMessages(channel, externalConversationId, filters, cursor, MESSAGE_PAGE_SIZE),
      );
      if (result.messages.length === 0) break;

      const res = await this.importer.importMessages(
        channel,
        conversationId,
        result.messages,
      );
      imported += res.imported;
      cursor = result.nextCursor;
      if (imported >= MAX_MESSAGES_PER_CONVERSATION) break;
      await this.sleep(REQUEST_DELAY_MS);
    } while (cursor);
    return imported;
  }

  private async isCancelled(syncJobId: string): Promise<boolean> {
    const current = await this.prisma.channelSyncJob.findUnique({
      where: { id: syncJobId },
      select: { status: true },
    });
    return current?.status === ChannelSyncStatus.CANCELLED;
  }

  private async markFailed(syncJobId: string, message: string): Promise<void> {
    await this.prisma.channelSyncJob.update({
      where: { id: syncJobId },
      data: {
        status: ChannelSyncStatus.FAILED,
        finishedAt: new Date(),
        errorMessage: message,
      },
    });
  }

  private emitProgress(
    organizationId: string,
    syncJobId: string,
    channelId: string,
    payload: Record<string, any>,
  ): void {
    this.realtimeGateway.emitToChannel(channelId, 'channel:sync-progress', {
      syncJobId,
      channelId,
      ...payload,
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  private isRateLimitError(err: any): boolean {
    const msg = err?.message || '';
    return /request limit reached|#4\]|#17\]|#32\]|#613\]|rate limit/i.test(msg);
  }

  private async withRateLimit<T>(fn: () => Promise<T>): Promise<T> {
    let attempt = 0;
    while (true) {
      try {
        return await fn();
      } catch (err: any) {
        if (!this.isRateLimitError(err) || attempt >= MAX_RATE_LIMIT_RETRIES) {
          throw err;
        }
        attempt++;
        const delay = RATE_LIMIT_BACKOFF_MS * Math.pow(2, attempt - 1);
        this.logger.warn(
          `Rate limit hit (attempt ${attempt}/${MAX_RATE_LIMIT_RETRIES}). Backing off ${delay}ms...`,
        );
        await this.sleep(delay);
      }
    }
  }
}
