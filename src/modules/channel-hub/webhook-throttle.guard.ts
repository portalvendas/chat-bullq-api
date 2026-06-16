import { CanActivate, ExecutionContext, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';

/**
 * Lightweight in-memory sliding-window rate limiter for the webhook endpoint.
 * Keyed by `${ip}:${channelType}`. Dropping a webhook returns 429 — providers
 * retry automatically and the append-only webhook_events table already gives
 * us a replay path for edge cases.
 *
 * Limits are generous enough not to impact legitimate traffic (Meta sends
 * bursts of ~50 events/sec during backfills) but defensive against abusive
 * hosts. Scale vertically via env vars when needed.
 */
@Injectable()
export class WebhookThrottleGuard implements CanActivate {
  private readonly logger = new Logger(WebhookThrottleGuard.name);

  private static readonly WINDOW_MS = 10_000; // 10s
  private static readonly MAX_HITS = 600; // ~60 req/s per IP+channelType

  private readonly hits = new Map<string, number[]>();
  private lastGc = 0;

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const ip = this.extractIp(req);
    const channelType = String(req.params?.channelType || 'unknown');
    const key = `${ip}:${channelType}`;

    const now = Date.now();
    const windowStart = now - WebhookThrottleGuard.WINDOW_MS;
    const entries = this.hits.get(key) || [];
    const recent = entries.filter((t) => t >= windowStart);
    recent.push(now);
    this.hits.set(key, recent);

    // Light GC to keep map bounded (runs at most once per 30s).
    if (now - this.lastGc > 30_000) {
      this.lastGc = now;
      for (const [k, arr] of this.hits.entries()) {
        const trimmed = arr.filter((t) => t >= windowStart);
        if (trimmed.length === 0) this.hits.delete(k);
        else this.hits.set(k, trimmed);
      }
    }

    if (recent.length > WebhookThrottleGuard.MAX_HITS) {
      this.logger.warn(`Throttled webhook from ${key} (${recent.length} hits/10s)`);
      return false;
    }
    return true;
  }

  private extractIp(req: Request): string {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.length > 0) return fwd.split(',')[0].trim();
    if (Array.isArray(fwd) && fwd.length > 0) return fwd[0].split(',')[0].trim();
    return req.ip || 'unknown';
  }
}
