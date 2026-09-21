import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

/**
 * Throttle de envio do WhatsApp por NÚMERO (phone_number_id) e por CAMPANHA.
 * Janela fixa de 1s no Redis, checada atomicamente por Lua — só incrementa se
 * ambos os limites permitem. `waitMs` retorna 0 (pode enviar já) ou os ms até a
 * próxima janela (o worker re-agenda com moveToDelayed).
 *
 * Limite por número: env `WA_SEND_RATE_PER_SEC` (default 40) — protege a saúde
 * do número. Limite por campanha: derivado do `throttlePerMinute` do disparo.
 */
@Injectable()
export class WaRateLimiter implements OnModuleDestroy {
  private readonly logger = new Logger(WaRateLimiter.name);
  private readonly redis: Redis;
  private readonly numberPerSec: number;

  private static readonly WINDOW_MS = 1000;
  private static readonly SCRIPT = `
    local n = tonumber(redis.call('GET', KEYS[1]) or '0')
    local c = tonumber(redis.call('GET', KEYS[2]) or '0')
    if n < tonumber(ARGV[1]) and c < tonumber(ARGV[2]) then
      redis.call('INCR', KEYS[1]); redis.call('PEXPIRE', KEYS[1], ARGV[3])
      redis.call('INCR', KEYS[2]); redis.call('PEXPIRE', KEYS[2], ARGV[3])
      return 0
    end
    return tonumber(ARGV[3]) - (tonumber(ARGV[4]) % tonumber(ARGV[3]))
  `;

  constructor(private readonly config: ConfigService) {
    this.redis = new Redis({
      host: this.config.get<string>('REDIS_HOST', 'localhost'),
      port: this.config.get<number>('REDIS_PORT', 6379),
      password: this.config.get<string>('REDIS_PASSWORD') || undefined,
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
    this.numberPerSec = Math.max(
      1,
      this.config.get<number>('WA_SEND_RATE_PER_SEC', 40),
    );
  }

  async onModuleDestroy(): Promise<void> {
    try {
      await this.redis.quit();
    } catch {
      /* noop */
    }
  }

  /**
   * Tenta consumir um token. Retorna 0 se pode enviar agora; senão os ms até a
   * próxima janela. Best-effort: se o Redis falhar, libera (0) e loga.
   */
  async waitMs(
    phoneNumberId: string,
    broadcastId: string,
    perMinute: number,
  ): Promise<number> {
    const now = Date.now();
    const sec = Math.floor(now / WaRateLimiter.WINDOW_MS);
    const numKey = `wa:rl:num:${phoneNumberId}:${sec}`;
    const campKey = `wa:rl:camp:${broadcastId}:${sec}`;
    const campaignPerSec = Math.max(1, Math.ceil((perMinute || 600) / 60));
    try {
      const res = (await this.redis.eval(
        WaRateLimiter.SCRIPT,
        2,
        numKey,
        campKey,
        String(this.numberPerSec),
        String(campaignPerSec),
        String(WaRateLimiter.WINDOW_MS),
        String(now),
      )) as number;
      return Number(res) || 0;
    } catch (err: any) {
      this.logger.warn(`rate-limit indisponível (libera): ${err?.message ?? err}`);
      return 0;
    }
  }
}
