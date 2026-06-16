import { Inject, Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

import { REDIS_CLIENT_TOKEN } from './redis.provider';
import { ShortTermConfig, StoredMessage } from './short-term.types';

/**
 * Working-memory cache for AI agent conversations.
 *
 * Storage layout: a single Redis LIST per conversation
 *   key:    `ai:conversation:{conversationId}:messages`
 *   layout: head (index 0) = most recent message
 *   ops:    LPUSH on append, LTRIM to cap at maxMessages, EXPIRE on every
 *           append so active conversations never lose their cache.
 *
 * Reads return messages in chronological order (oldest -> newest) so the
 * caller can feed them straight into an LLM prompt.
 */
@Injectable()
export class ShortTermMemoryService implements OnModuleDestroy {
  private readonly logger = new Logger(ShortTermMemoryService.name);
  private readonly config: ShortTermConfig;

  private static readonly DEFAULT_MAX_MESSAGES = 100;
  private static readonly DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

  constructor(
    @Inject(REDIS_CLIENT_TOKEN) private readonly redis: Redis,
    configService: ConfigService,
  ) {
    this.config = {
      maxMessages: configService.get<number>(
        'SHORT_TERM_MAX_MESSAGES',
        ShortTermMemoryService.DEFAULT_MAX_MESSAGES,
      ),
      ttlSeconds: configService.get<number>(
        'SHORT_TERM_TTL_SECONDS',
        ShortTermMemoryService.DEFAULT_TTL_SECONDS,
      ),
    };
  }

  async onModuleDestroy(): Promise<void> {
    try {
      // Only quit if we own the connection (provider is local to this module).
      if (this.redis.status !== 'end') {
        await this.redis.quit();
      }
    } catch {
      /* noop */
    }
  }

  private key(conversationId: string): string {
    return `ai:conversation:${conversationId}:messages`;
  }

  /**
   * Returns the most recent `limit` messages in chronological order
   * (oldest first). Default limit = 30, capped at the configured max.
   */
  async getRecent(
    conversationId: string,
    limit: number = 30,
  ): Promise<StoredMessage[]> {
    const safeLimit = Math.max(1, Math.min(limit, this.config.maxMessages));
    const raw = await this.redis.lrange(
      this.key(conversationId),
      0,
      safeLimit - 1,
    );

    const parsed: StoredMessage[] = [];
    for (const item of raw) {
      try {
        parsed.push(JSON.parse(item) as StoredMessage);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to parse cached message for conversation ${conversationId}: ${msg}`,
        );
      }
    }

    // Redis list head is newest; reverse to get chronological order.
    return parsed.reverse();
  }

  /**
   * Appends a new message to the cache. Trims to maxMessages and refreshes
   * the TTL so active conversations never expire mid-flight.
   */
  async append(
    conversationId: string,
    message: StoredMessage,
  ): Promise<void> {
    const k = this.key(conversationId);
    const payload = JSON.stringify(message);
    await this.redis
      .multi()
      .lpush(k, payload)
      .ltrim(k, 0, this.config.maxMessages - 1)
      .expire(k, this.config.ttlSeconds)
      .exec();
  }

  /** Drops the entire cache for a conversation. */
  async clear(conversationId: string): Promise<void> {
    await this.redis.del(this.key(conversationId));
  }

  /**
   * Read-through cache. Returns Redis-backed messages when available;
   * otherwise calls `dbLoader`, backfills the cache, and returns the result.
   *
   * `dbLoader` MUST return messages in chronological order (oldest first).
   */
  async getOrLoadFromDb(
    conversationId: string,
    dbLoader: () => Promise<StoredMessage[]>,
  ): Promise<StoredMessage[]> {
    const cached = await this.getRecent(conversationId, this.config.maxMessages);
    if (cached.length > 0) {
      this.logger.log({
        msg: 'short_term_cache_hit',
        conversationId,
        count: cached.length,
      });
      return cached;
    }

    this.logger.log({ msg: 'short_term_cache_miss', conversationId });
    const fromDb = await dbLoader();
    if (fromDb.length === 0) return fromDb;

    // Backfill in chronological order so head of list = newest.
    for (const m of fromDb) {
      await this.append(conversationId, m);
    }
    return fromDb;
  }
}
