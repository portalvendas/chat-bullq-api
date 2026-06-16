import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Single kill switch for the entire automation engine. When OFF:
//   • OutboxPoller still drains events but marks them PROCESSED with a
//     `killed_by_switch` note (no jobs enqueued, no actions executed).
//   • The worker also self-checks before doing any work — defense in depth
//     in case a stale BullMQ job arrives during a partial deploy.
//
// Operate this via the `AUTOMATIONS_ENABLED` env var. Default is FALSE
// in this PR — by design, deploying this PR to prod has zero behavior
// change. Subsequent PRs gate rollout per workspace via DB flags.
@Injectable()
export class KillSwitchService {
  private readonly logger = new Logger(KillSwitchService.name);
  private readonly enabled: boolean;

  constructor(config: ConfigService) {
    const raw = config.get<string>('AUTOMATIONS_ENABLED', 'false');
    this.enabled = raw === 'true' || raw === '1';
    this.logger.log(
      `Automations engine kill switch: ${this.enabled ? 'ENABLED' : 'DISABLED'}`,
    );
  }

  isEnabled(): boolean {
    return this.enabled;
  }
}
