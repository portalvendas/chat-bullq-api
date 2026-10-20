import { Injectable, Logger } from '@nestjs/common';
import { NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import {
  WAITING_KIND_LABEL,
  WaitingRow,
  waitingConversationsSql,
} from '../../common/waiting-reply.sql';

/** Minutos de espera até alertar (padrão 15; env LEAD_WAITING_ALERT_MIN). */
export const WAIT_ALERT_MIN = Number(process.env.LEAD_WAITING_ALERT_MIN) || 15;
/** Só alerta esperas recentes (não "acorda" conversas antigas). */
const LOOKBACK_HOURS = 24;
/** Janela de envio (horário de SP). Fora dela, segura e alerta no próximo ciclo dentro. */
const ALERT_HOUR_START = 8;
const ALERT_HOUR_END = 20;
const BATCH = 200;

/**
 * Alerta o VENDEDOR quando um lead fica esperando resposta humana.
 *
 * Regra de "esperando" = common/waiting-reply.sql.ts (robô na abertura conta
 * como resposta; cliente que respondeu ao robô e ficou sem humano, não).
 *
 *  - Destinatário: responsável da conversa → senão o vendedor do card aberto
 *    do contato → senão os gestores (OWNER/ADMIN), pra lead sem dono não sumir.
 *  - Idempotente: 1 alerta por mensagem do cliente (marca o id da última
 *    mensagem em conversations.metadata.waitAlertMsgId). Se o cliente escrever
 *    de novo e continuar sem resposta, alerta outra vez.
 *  - Só entre 08h e 20h (SP); esperas da noite são alertadas às 08h.
 */
@Injectable()
export class LeadWaitingService {
  private readonly logger = new Logger(LeadWaitingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  private withinAlertHours(now = new Date()): boolean {
    const h = Number(
      new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', hour: '2-digit', hourCycle: 'h23' }).format(now),
    );
    return h >= ALERT_HOUR_START && h < ALERT_HOUR_END;
  }

  /** Conversas esperando há mais de WAIT_ALERT_MIN e ainda não alertadas por esta mensagem. */
  async findToAlert(): Promise<WaitingRow[]> {
    return this.prisma.$queryRaw<WaitingRow[]>`
      SELECT w.* FROM (${waitingConversationsSql(Prisma.sql`
        c.status <> 'CLOSED'
        AND c.is_archived = false
        AND c.last_message_at >= (now() AT TIME ZONE 'UTC') - make_interval(hours => ${LOOKBACK_HOURS}::int)`)}) w
      JOIN conversations c ON c.id = w."conversationId"
      WHERE w."waitingSince" < (now() AT TIME ZONE 'UTC') - make_interval(mins => ${WAIT_ALERT_MIN}::int)
        AND w."waitingSince" >= (now() AT TIME ZONE 'UTC') - make_interval(hours => ${LOOKBACK_HOURS}::int)
        AND (c.metadata->>'waitAlertMsgId') IS DISTINCT FROM w."lastInboundId"
      ORDER BY w."waitingSince"
      LIMIT ${BATCH}`;
  }

  /** Um ciclo do job. Devolve quantos alertas saíram. */
  async run(): Promise<{ alerted: number; skippedOutsideHours: boolean }> {
    if (!this.withinAlertHours()) return { alerted: 0, skippedOutsideHours: true };
    const rows = await this.findToAlert();
    let alerted = 0;
    for (const w of rows) {
      try {
        await this.alertOne(w);
        alerted++;
      } catch (err: any) {
        this.logger.warn(`lead_waiting alerta falhou conv=${w.conversationId}: ${err?.message ?? err}`);
      }
    }
    if (alerted) this.logger.log(`lead_waiting alertas=${alerted}`);
    return { alerted, skippedOutsideHours: false };
  }

  private async alertOne(w: WaitingRow): Promise<void> {
    const [contact, card] = await Promise.all([
      this.prisma.contact.findFirst({
        where: { id: w.contactId, organizationId: w.organizationId },
        select: { name: true, phone: true },
      }),
      this.prisma.card.findFirst({
        where: { organizationId: w.organizationId, contactId: w.contactId, status: 'OPEN' },
        orderBy: { createdAt: 'desc' },
        select: { id: true, assignedToId: true, pipelineId: true },
      }),
    ]);
    const sellerId = w.assignedToId ?? card?.assignedToId ?? null;
    const minutes = Math.max(1, Math.round((Date.now() - new Date(w.waitingSince).getTime()) / 60000));
    const who = contact?.name || contact?.phone || 'Lead';
    const title = 'Lead esperando resposta';
    const body = `${who} ${WAITING_KIND_LABEL[w.kind]} há ${minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}` : `${minutes} min`}.`;
    const data = {
      kind: 'lead_waiting',
      waitingKind: w.kind,
      conversationId: w.conversationId,
      contactId: w.contactId,
      cardId: card?.id ?? null,
      waitingSince: new Date(w.waitingSince).toISOString(),
    };

    // Marca ANTES de notificar: se a entrega falhar no meio, não dispara em loop.
    const marked = await this.prisma.$executeRaw`
      UPDATE conversations
      SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{waitAlertMsgId}', to_jsonb(${w.lastInboundId}::text))
      WHERE id = ${w.conversationId}
        AND (metadata->>'waitAlertMsgId') IS DISTINCT FROM ${w.lastInboundId}`;
    if (!marked) return; // outra instância já alertou esta mensagem

    if (sellerId) {
      await this.notifications.notify({
        recipientId: sellerId,
        organizationId: w.organizationId,
        type: 'LEAD_WAITING' as NotificationType,
        title,
        body,
        data,
      });
    } else {
      await this.notifications.notifyManagersAndUser({
        organizationId: w.organizationId,
        type: 'LEAD_WAITING' as NotificationType,
        title: `${title} (sem vendedor)`,
        body,
        data,
      });
    }
  }
}
