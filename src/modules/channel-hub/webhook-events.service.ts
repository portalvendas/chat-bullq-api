import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, WebhookEventStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

/**
 * Append-only log of every webhook received. Serves as source-of-truth
 * for the inbound pipeline — any processing failure can be replayed from here.
 *
 * NEVER mutate a row destructively: status changes are append-only (RECEIVED → PROCESSED|FAILED|UNROUTED).
 */
@Injectable()
export class WebhookEventsService {
  private readonly logger = new Logger(WebhookEventsService.name);

  // Rough cap on the headers JSON to avoid blowing up row size with user-agents / metadata.
  private static readonly MAX_HEADER_KEYS = 40;

  constructor(private readonly prisma: PrismaService) {}

  async record(
    channelId: string,
    channelType: ChannelType,
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<string> {
    const row = await this.prisma.webhookEvent.create({
      data: {
        channelId,
        channelType,
        status: WebhookEventStatus.RECEIVED,
        rawPayload: this.safeJson(payload),
        headers: this.pickSafeHeaders(headers),
      },
      select: { id: true },
    });
    return row.id;
  }

  async recordUnrouted(
    channelType: ChannelType,
    payload: unknown,
    headers: Record<string, string>,
  ): Promise<string> {
    const row = await this.prisma.webhookEvent.create({
      data: {
        channelType,
        status: WebhookEventStatus.UNROUTED,
        rawPayload: this.safeJson(payload),
        headers: this.pickSafeHeaders(headers),
      },
      select: { id: true },
    });
    return row.id;
  }

  async markProcessed(eventId: string): Promise<void> {
    try {
      await this.prisma.webhookEvent.update({
        where: { id: eventId },
        data: {
          status: WebhookEventStatus.PROCESSED,
          processedAt: new Date(),
        },
      });
    } catch (err: any) {
      this.logger.warn(`markProcessed failed for ${eventId}: ${err.message}`);
    }
  }

  async markFailed(eventId: string, errorMessage: string): Promise<void> {
    try {
      await this.prisma.webhookEvent.update({
        where: { id: eventId },
        data: {
          status: WebhookEventStatus.FAILED,
          processedAt: new Date(),
          errorMessage: errorMessage.slice(0, 2000),
        },
      });
    } catch (err: any) {
      this.logger.warn(`markFailed failed for ${eventId}: ${err.message}`);
    }
  }

  private safeJson(value: unknown): any {
    try {
      return JSON.parse(JSON.stringify(value ?? null));
    } catch {
      return null;
    }
  }

  private pickSafeHeaders(headers: Record<string, string>): Record<string, string> {
    const redactedKeys = new Set([
      'authorization',
      'cookie',
      'set-cookie',
      'x-api-key',
    ]);
    const out: Record<string, string> = {};
    let count = 0;
    for (const [key, value] of Object.entries(headers ?? {})) {
      if (count >= WebhookEventsService.MAX_HEADER_KEYS) break;
      const lower = key.toLowerCase();
      out[lower] = redactedKeys.has(lower) ? '[redacted]' : String(value);
      count++;
    }
    return out;
  }
}
