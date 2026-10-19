import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { HeartbeatDto, STATE_RANK } from './dto/heartbeat.dto';
import { localDay, sqlUtc, truncMinute } from './productivity.time';

/**
 * Grava a atividade do vendedor por MINUTO.
 *
 * Idempotente por (org, usuário, minuto): o navegador manda heartbeat a cada
 * ~30s e pode ter várias abas abertas — o upsert mantém o MAIOR estado do
 * minuto (em uso > aberto sem interação > segundo plano). O minuto vem do
 * relógio do SERVIDOR, nunca do cliente.
 */
@Injectable()
export class ProductivityTrackingService {
  private readonly logger = new Logger(ProductivityTrackingService.name);

  constructor(private readonly prisma: PrismaService) {}

  async heartbeat(organizationId: string, userId: string, dto: HeartbeatDto): Promise<void> {
    const now = new Date();
    const minuteAt = truncMinute(now);
    const day = localDay(now);
    const state = STATE_RANK[dto.state];
    const area = dto.area || null;
    const conversationId = dto.conversationId || null;
    try {
      await this.prisma.$executeRaw`
        INSERT INTO user_activity_minutes
          (organization_id, user_id, minute_at, day, state, area, conversation_id)
        VALUES (${organizationId}, ${userId}, ${sqlUtc(minuteAt)}, ${day}, ${state}::smallint, ${area}, ${conversationId})
        ON CONFLICT (organization_id, user_id, minute_at) DO UPDATE SET
          state = GREATEST(user_activity_minutes.state, EXCLUDED.state),
          area = CASE WHEN EXCLUDED.state >= user_activity_minutes.state
                      THEN COALESCE(EXCLUDED.area, user_activity_minutes.area)
                      ELSE user_activity_minutes.area END,
          conversation_id = CASE WHEN EXCLUDED.state >= user_activity_minutes.state
                      THEN COALESCE(EXCLUDED.conversation_id, user_activity_minutes.conversation_id)
                      ELSE user_activity_minutes.conversation_id END`;
    } catch (err: any) {
      // Telemetria nunca derruba o uso do CRM: loga e segue.
      this.logger.warn(
        `heartbeat falhou (org=${organizationId} user=${userId}): ${err?.message ?? err}`,
      );
    }
  }

  /** Remove minutos antigos (retenção). Devolve quantas linhas saíram. */
  async purgeOlderThan(days: number): Promise<number> {
    const cutoff = new Date(Date.now() - days * 24 * 3600 * 1000);
    return this.prisma.$executeRaw`DELETE FROM user_activity_minutes WHERE minute_at < ${sqlUtc(cutoff)}`;
  }
}
