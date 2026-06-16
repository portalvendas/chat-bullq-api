import { ChannelType, MessageDirection } from '@prisma/client';
import { MessageContentType, NormalizedMessageContent } from './normalized-message.types';

export interface NormalizedHistoricalConversation {
  externalConversationId: string;
  externalContactId: string;
  contactName?: string;
  contactPhone?: string;
  contactAvatarUrl?: string;
  isGroup?: boolean;
  lastMessageAt?: Date;
  unreadCount?: number;
  rawPayload?: unknown;
}

export interface NormalizedHistoricalMessage {
  externalMessageId: string;
  externalConversationId: string;
  externalContactId: string;
  direction: MessageDirection;
  timestamp: Date;
  type: MessageContentType;
  content: NormalizedMessageContent;
  senderName?: string;
  replyToExternalId?: string;
  rawPayload?: unknown;
}

export interface FetchConversationsResult {
  conversations: NormalizedHistoricalConversation[];
  nextCursor?: string;
}

export interface FetchMessagesResult {
  messages: NormalizedHistoricalMessage[];
  nextCursor?: string;
}

export interface SyncCapabilities {
  supportsHistoryImport: boolean;
  supportsDeltaSync: boolean;
  defaultLookbackDays: number;
  maxLookbackDays?: number;
}

export interface HistorySyncFilters {
  sinceTimestamp?: Date;
  untilTimestamp?: Date;
}
