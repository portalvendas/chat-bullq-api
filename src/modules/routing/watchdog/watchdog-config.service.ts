import { Injectable } from '@nestjs/common';
import type { Organization } from '@prisma/client';
import {
  DEFAULT_WATCHDOG_CONFIG,
  WatchdogConfig,
} from './watchdog.types';
import {
  isOpenAt,
  type ExpedienteOrg,
} from '../../../common/business-hours/business-hours.util';

/**
 * Resolve a config efetiva do watchdog (merge defaults + override do banco)
 * e responde se estamos DENTRO do expediente — usando o Expediente canônico
 * da org (mesma fonte da IA e dos salesbots). Sem horário próprio.
 */
@Injectable()
export class WatchdogConfigService {
  resolve(org: Pick<Organization, 'watchdogConfig'>): Required<WatchdogConfig> {
    const override = (org.watchdogConfig as WatchdogConfig | null) ?? {};
    return {
      delayBotMin: override.delayBotMin ?? DEFAULT_WATCHDOG_CONFIG.delayBotMin,
      delayPendingMin:
        override.delayPendingMin ?? DEFAULT_WATCHDOG_CONFIG.delayPendingMin,
      delayHumanIdleMin:
        override.delayHumanIdleMin ?? DEFAULT_WATCHDOG_CONFIG.delayHumanIdleMin,
      maxAttempts:
        override.maxAttempts ?? DEFAULT_WATCHDOG_CONFIG.maxAttempts,
    };
  }

  isWithinBusinessHours(org: ExpedienteOrg): boolean {
    return isOpenAt(org);
  }
}
