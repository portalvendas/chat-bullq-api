export interface RateLimitConfig {
  maxPerSecond: number;
  maxPerMinute: number;
  windowMs: number;
}
