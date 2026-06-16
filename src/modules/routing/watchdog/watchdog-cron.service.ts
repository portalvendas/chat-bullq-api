import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  ConversationStatus,
  MessageDirection,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { WatchdogService } from './watchdog.service';
import { WatchdogConfigService } from './watchdog-config.service';
import {
  WATCHDOG_QUEUE,
  WATCHDOG_FALLBACK_JOB,
  WATCHDOG_FALLBACK_PATTERN,
} from './watchdog.types';

/**
 * Cron de fallback: a cada 15min varre conversas potencialmente presas
 * que escaparam da camada reativa. Casos de uso:
 *
 *  - Redis caiu e perdeu jobs delay-based.
 *  - Deploy reiniciou o worker antes do delay terminar.
 *  - Conversa antiga (criada antes do watchdog existir) sem job algum.
 *  - Race onde o `scheduleCheck` falhou silenciosamente.
 *
 * Estratégia: query barata indexada por (orgId, status, lastMessageAt)
 * com WHERE deleted_at IS NULL. Filtra:
 *  - status IN (BOT, PENDING, OPEN)
 *  - lastMessageAt < now() - 15min (margem)
 *  - aiEnabled IS NOT FALSE (respeita kill switch humano)
 *  - watchdogJobId IS NULL OR job não existe mais na fila
 *  - última mensagem é INBOUND (precisa confirmar — feito por org)
 *
 * Apenas enfileira chamando `WatchdogService.scheduleCheck()` — NÃO
 * processa direto. O processor reativo decide ação centralmente.
 */
@Injectable()
export class WatchdogCronService implements OnModuleInit {
  private readonly logger = new Logger(WatchdogCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly watchdog: WatchdogService,
    private readonly config: WatchdogConfigService,
    @InjectQueue(WATCHDOG_QUEUE) private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        WATCHDOG_FALLBACK_JOB,
        {},
        {
          repeat: { pattern: WATCHDOG_FALLBACK_PATTERN },
          jobId: 'watchdog-fallback-cron',
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log({
        msg: 'watchdog_fallback_cron_registered',
        pattern: WATCHDOG_FALLBACK_PATTERN,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to register watchdog fallback cron: ${msg}`);
    }
  }

  /**
   * Chamado pelo processor quando o repeatable dispara. Public pra
   * facilitar teste manual e invocação direta de admin endpoint.
   */
  async scanAndEnqueue(): Promise<{ scanned: number; enqueued: number }> {
    // Margem além do menor delay configurável — se org tem delayBotMin=5,
    // não queremos enfileirar conversa que ficou parada só 4min. 5min de
    // buffer evita falso positivo durante a janela do timer reativo.
    const now = new Date();
    const cutoff = new Date(now.getTime() - 5 * 60 * 1000);

    const candidates = await this.prisma.conversation.findMany({
      where: {
        deletedAt: null,
        isStuck: false,
        status: {
          in: [
            ConversationStatus.BOT,
            ConversationStatus.PENDING,
            ConversationStatus.OPEN,
          ],
        },
        lastMessageAt: { lt: cutoff },
        // tri-state: null ou true = OK, false = humano desligou IA
        OR: [{ aiEnabled: null }, { aiEnabled: true }],
        organization: { watchdogEnabled: true },
      },
      select: {
        id: true,
        organizationId: true,
        watchdogJobId: true,
        status: true,
        lastMessageAt: true,
      },
      take: 500, // hard cap por execução — protege contra explosão
    });

    let enqueued = 0;
    for (const conv of candidates) {
      // Confirma que a última msg é INBOUND. Se for OUTBOUND, já
      // respondemos — esse caso o cron não trata.
      const lastMsg = await this.prisma.message.findFirst({
        where: { conversationId: conv.id },
        orderBy: { createdAt: 'desc' },
        select: { direction: true },
      });
      if (!lastMsg || lastMsg.direction !== MessageDirection.INBOUND) continue;

      // Se já tem job ativo, não duplica.
      if (conv.watchdogJobId) {
        const existingJob = await this.queue.getJob(conv.watchdogJobId);
        if (existingJob) continue;
      }

      try {
        await this.watchdog.enqueueFromCron(conv.id);
        enqueued++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to enqueue watchdog from cron for conv ${conv.id}: ${msg}`,
        );
      }
    }

    if (candidates.length > 0) {
      this.logger.log(
        `Watchdog fallback scan: scanned=${candidates.length} enqueued=${enqueued}`,
      );
    }

    return { scanned: candidates.length, enqueued };
  }
}
