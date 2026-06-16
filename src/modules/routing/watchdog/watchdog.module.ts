import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { AiAgentsModule } from '../../ai-agents/ai-agents.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { WatchdogService } from './watchdog.service';
import { WatchdogConfigService } from './watchdog-config.service';
import { WatchdogCronService } from './watchdog-cron.service';
import { WatchdogTimerProcessor } from './watchdog-timer.processor';
import { WATCHDOG_QUEUE } from './watchdog.types';

/**
 * Watchdog module — detecção e reativação de conversas presas.
 *
 * Exporta `WatchdogService` pra que outros módulos (Messaging) chamem
 * `scheduleCheck()` em mensagens INBOUND e `cancelCheck()` em mensagens
 * OUTBOUND. O processor (`WatchdogTimerProcessor`) é registrado como
 * provider mas não é exportado — só roda em background.
 *
 * Importa `AiAgentsModule` pra reativar IA via `AiAgentRunnerService`.
 * Sem dependência circular: AiAgentsModule não importa WatchdogModule
 * (cancelamento de timer acontece nas bordas onde mensagens são
 * persistidas, não dentro do agent runner).
 */
@Module({
  imports: [
    BullModule.registerQueue({ name: WATCHDOG_QUEUE }),
    AiAgentsModule,
    NotificationsModule,
    RealtimeModule,
  ],
  providers: [
    WatchdogService,
    WatchdogConfigService,
    WatchdogCronService,
    WatchdogTimerProcessor,
  ],
  exports: [WatchdogService, WatchdogConfigService, BullModule],
})
export class WatchdogModule {}
