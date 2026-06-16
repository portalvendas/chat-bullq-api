import { Channel, ChannelType } from '@prisma/client';
import {
  FetchConversationsResult,
  FetchMessagesResult,
  HistorySyncFilters,
  SyncCapabilities,
} from './types';

export interface HistorySyncPort {
  readonly channelType: ChannelType;

  getSyncCapabilities(): SyncCapabilities;

  fetchConversations(
    channel: Channel,
    filters: HistorySyncFilters,
    cursor?: string,
    limit?: number,
  ): Promise<FetchConversationsResult>;

  fetchMessages(
    channel: Channel,
    externalConversationId: string,
    filters: HistorySyncFilters,
    cursor?: string,
    limit?: number,
  ): Promise<FetchMessagesResult>;
}

export const HISTORY_SYNC_PORT = 'HISTORY_SYNC_PORT';
