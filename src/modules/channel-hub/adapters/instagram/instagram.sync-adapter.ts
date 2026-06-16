import { Injectable, Logger } from '@nestjs/common';
import { Channel, ChannelType, MessageDirection } from '@prisma/client';
import { HistorySyncPort } from '../../ports/history-sync.port';
import {
  FetchConversationsResult,
  FetchMessagesResult,
  HistorySyncFilters,
  MessageContentType,
  NormalizedHistoricalConversation,
  NormalizedHistoricalMessage,
  NormalizedMessageContent,
  SyncCapabilities,
} from '../../ports/types';
import { InstagramHttpClient } from './instagram.http-client';

@Injectable()
export class InstagramSyncAdapter implements HistorySyncPort {
  readonly channelType = ChannelType.INSTAGRAM;
  private readonly logger = new Logger(InstagramSyncAdapter.name);

  constructor(private readonly httpClient: InstagramHttpClient) {}

  getSyncCapabilities(): SyncCapabilities {
    return {
      supportsHistoryImport: true,
      supportsDeltaSync: true,
      defaultLookbackDays: 7,
      maxLookbackDays: 365,
    };
  }

  async fetchConversations(
    channel: Channel,
    filters: HistorySyncFilters,
    cursor?: string,
    limit = 50,
  ): Promise<FetchConversationsResult> {
    const businessId = await this.httpClient.resolveBusinessId(channel);
    if (!businessId) {
      throw new Error('Cannot sync Instagram: missing business id (call /me)');
    }

    const { data, nextCursor } = await this.httpClient.listConversations(
      channel,
      cursor,
      limit,
    );

    const conversations: NormalizedHistoricalConversation[] = [];
    for (const conv of data) {
      const normalized = this.normalizeConversation(conv, businessId);
      if (!normalized) continue;
      if (filters.sinceTimestamp && normalized.lastMessageAt) {
        if (normalized.lastMessageAt < filters.sinceTimestamp) continue;
      }
      conversations.push(normalized);
    }

    return { conversations, nextCursor };
  }

  async fetchMessages(
    channel: Channel,
    externalConversationId: string,
    filters: HistorySyncFilters,
    cursor?: string,
    limit = 50,
  ): Promise<FetchMessagesResult> {
    const businessId = await this.httpClient.resolveBusinessId(channel);
    if (!businessId) {
      throw new Error('Cannot sync Instagram: missing business id (call /me)');
    }

    const { data, nextCursor } = await this.httpClient.listConversationMessages(
      channel,
      externalConversationId,
      cursor,
      limit,
    );

    const messages: NormalizedHistoricalMessage[] = [];
    let reachedLookbackLimit = false;

    for (const raw of data) {
      const normalized = this.normalizeMessage(raw, externalConversationId, businessId);
      if (!normalized) continue;

      if (filters.sinceTimestamp && normalized.timestamp < filters.sinceTimestamp) {
        reachedLookbackLimit = true;
        break;
      }

      messages.push(normalized);
    }

    return {
      messages,
      nextCursor: reachedLookbackLimit ? undefined : nextCursor,
    };
  }

  private normalizeConversation(
    conv: Record<string, any>,
    igUserId: string,
  ): NormalizedHistoricalConversation | null {
    if (!conv?.id) return null;

    const participants = conv.participants?.data || [];
    const contact = participants.find((p: any) => p?.id && p.id !== igUserId);
    if (!contact?.id) return null;

    const lastMessageAt = conv.updated_time ? new Date(conv.updated_time) : undefined;
    const contactName = contact.username || contact.name || undefined;

    return {
      externalConversationId: conv.id,
      externalContactId: contact.id,
      contactName,
      contactAvatarUrl: undefined,
      isGroup: false,
      lastMessageAt,
      unreadCount: 0,
      rawPayload: conv,
    };
  }

  private normalizeMessage(
    raw: Record<string, any>,
    externalConversationId: string,
    igUserId: string,
  ): NormalizedHistoricalMessage | null {
    if (!raw?.id) return null;

    const fromId = raw.from?.id;
    if (!fromId) return null;

    const direction: MessageDirection =
      fromId === igUserId ? MessageDirection.OUTBOUND : MessageDirection.INBOUND;

    const externalContactId =
      direction === MessageDirection.OUTBOUND
        ? this.extractRecipientId(raw, igUserId) ?? fromId
        : fromId;

    const timestamp = raw.created_time ? new Date(raw.created_time) : new Date();
    const type = this.resolveContentType(raw);
    const content = this.extractContent(raw, type);

    return {
      externalMessageId: raw.id,
      externalConversationId,
      externalContactId,
      direction,
      timestamp,
      type,
      content,
      senderName: raw.from?.username || raw.from?.name || undefined,
      rawPayload: raw,
    };
  }

  private extractRecipientId(raw: Record<string, any>, igUserId: string): string | null {
    const recipients = raw.to?.data || [];
    const other = recipients.find((r: any) => r?.id && r.id !== igUserId);
    return other?.id ?? null;
  }

  private resolveContentType(raw: Record<string, any>): MessageContentType {
    const attachments = raw.attachments?.data || [];
    if (attachments.length > 0) {
      const first = attachments[0];
      const mime: string = first?.mime_type || '';
      const rawType: string = first?.type || (first?.image_data ? 'image' : '');
      if (mime.startsWith('image/') || rawType === 'image' || first?.image_data) return MessageContentType.IMAGE;
      if (mime.startsWith('video/') || rawType === 'video' || first?.video_data) return MessageContentType.VIDEO;
      if (mime.startsWith('audio/') || rawType === 'audio') return MessageContentType.AUDIO;
      return MessageContentType.DOCUMENT;
    }
    if (raw.story) return MessageContentType.TEXT;
    if (raw.shares?.data?.length) return MessageContentType.TEXT;
    return MessageContentType.TEXT;
  }

  private extractContent(
    raw: Record<string, any>,
    type: MessageContentType,
  ): NormalizedMessageContent {
    if (raw.message) {
      const attachments = raw.attachments?.data || [];
      if (attachments.length > 0 && type !== MessageContentType.TEXT) {
        const first = attachments[0];
        const url =
          first?.image_data?.url ||
          first?.video_data?.url ||
          first?.file_url ||
          first?.url ||
          '';
        return {
          text: raw.message,
          caption: raw.message,
          mediaUrl: url,
          mimeType: first?.mime_type,
          fileName: first?.name,
        };
      }
      return { text: raw.message };
    }

    const attachments = raw.attachments?.data || [];
    if (attachments.length > 0) {
      const first = attachments[0];
      const url =
        first?.image_data?.url ||
        first?.video_data?.url ||
        first?.file_url ||
        first?.url ||
        '';
      return {
        mediaUrl: url,
        mimeType: first?.mime_type,
        fileName: first?.name,
      };
    }

    if (raw.story?.mention?.link) {
      return { text: '[Story mention]', mediaUrl: raw.story.mention.link };
    }

    return { text: '[Unsupported message]' };
  }
}
