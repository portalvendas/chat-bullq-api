import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { NotificationType, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import { NotificationsService } from '../notifications/notifications.service';
import { syncConversationsWithCard } from '../../common/card-owner.util';
import { humanOutboundSql } from '../../common/waiting-reply.sql';
import { LeadTransferDto } from './dto/lead-transfer.dto';

/** Valor do filtro de origem que significa "leads sem vendedor". */
export const NO_OWNER = '__none__';
const PREVIEW_LIMIT = 1000;

export interface LeadTransferPreviewItem {
  id: string;
  title: string;
  createdAt: Date;
  temperature: string | null;
  stage: string;
  pipeline: string;
  contactName: string | null;
  phone: string | null;
  /** Última mensagem HUMANA desde a entrada do lead (null = nunca teve). */
  lastHumanAt: Date | null;
  /** Última mensagem do cliente (qualquer época). */
  lastInboundAt: Date | null;
}

/**
 * Transferência de leads entre vendedores (OWNER/ADMIN).
 *
 * "Lead" = card ABERTO. Transferir troca o vendedor do card e leva junto a(s)
 * conversa(s) do lead (syncConversationsWithCard), com histórico
 * `source: lead_transfer` e notificação no sino de quem recebe.
 *
 * "Sem contato humano" usa a regra única do sistema (humanOutboundSql):
 * mensagem da vendedora no CRM, no celular (eco) ou Salesbot disparado à mão.
 * Boas-vindas e follow-ups automáticos NÃO contam como contato humano.
 */
@Injectable()
export class LeadTransferService {
  private readonly logger = new Logger(LeadTransferService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Prévia: leads abertos do vendedor de origem, criados no período.
   * @example GET /pipelines/lead-transfer/preview?fromUserId=u1&from=2026-11-01T03:00:00Z&to=2026-11-26T02:59:59Z&noHumanContact=1
   *   → { items: [{ id, title, stage, temperature, lastHumanAt: null, ... }], total: 12, truncated: false }
   */
  async preview(
    organizationId: string,
    q: { fromUserId: string; from?: string; to?: string; noHumanContact?: boolean; pipelineId?: string },
  ): Promise<{ items: LeadTransferPreviewItem[]; total: number; truncated: boolean }> {
    if (!q.fromUserId) throw new BadRequestException('Informe o vendedor de origem');

    const owner =
      q.fromUserId === NO_OWNER
        ? Prisma.sql`k.assigned_to_id IS NULL`
        : Prisma.sql`k.assigned_to_id = ${q.fromUserId}`;
    const fromD = q.from ? new Date(q.from) : null;
    const toD = q.to ? new Date(q.to) : null;
    const range = Prisma.join(
      [
        fromD && !isNaN(fromD.getTime())
          ? Prisma.sql`k.created_at >= (${fromD.toISOString()}::timestamptz AT TIME ZONE 'UTC')`
          : Prisma.sql`true`,
        toD && !isNaN(toD.getTime())
          ? Prisma.sql`k.created_at <= (${toD.toISOString()}::timestamptz AT TIME ZONE 'UTC')`
          : Prisma.sql`true`,
      ],
      ' AND ',
    );
    const pipe = q.pipelineId ? Prisma.sql`AND k.pipeline_id = ${q.pipelineId}` : Prisma.empty;
    const onlyNoHuman = q.noHumanContact ? Prisma.sql`WHERE x."lastHumanAt" IS NULL` : Prisma.empty;
    const human = humanOutboundSql('m');

    const rows = await this.prisma.$queryRaw<LeadTransferPreviewItem[]>`
      SELECT * FROM (
        SELECT k.id, k.title, k.created_at AS "createdAt",
               k.metadata->>'leadTemperature' AS "temperature",
               st.name AS "stage", pl.name AS "pipeline",
               ct.name AS "contactName", ct.phone AS "phone",
               (SELECT max(m.created_at) FROM conversations cv JOIN messages m ON m.conversation_id = cv.id
                 WHERE cv.contact_id = k.contact_id AND cv.organization_id = k.organization_id
                   AND ${human} AND m.created_at >= k.created_at) AS "lastHumanAt",
               (SELECT max(m.created_at) FROM conversations cv JOIN messages m ON m.conversation_id = cv.id
                 WHERE cv.contact_id = k.contact_id AND cv.organization_id = k.organization_id
                   AND m.direction = 'INBOUND') AS "lastInboundAt"
        FROM cards k
        JOIN pipeline_stages st ON st.id = k.stage_id
        JOIN pipelines pl ON pl.id = k.pipeline_id
        LEFT JOIN contacts ct ON ct.id = k.contact_id
        WHERE k.organization_id = ${organizationId} AND k.status = 'OPEN'
          AND ${owner} AND ${range} ${pipe}
      ) x
      ${onlyNoHuman}
      ORDER BY x."createdAt" DESC
      LIMIT ${PREVIEW_LIMIT + 1}`;

    const truncated = rows.length > PREVIEW_LIMIT;
    const items = truncated ? rows.slice(0, PREVIEW_LIMIT) : rows;
    return { items, total: items.length, truncated };
  }

  /**
   * Executa: troca o vendedor dos cards e das conversas do lead.
   * @example POST /pipelines/lead-transfer { cardIds: ['c1','c2'], toUserId: 'u2', fromUserId: 'u1' }
   *   → { transferred: 2, conversationsUpdated: 2, skipped: [] }
   */
  async transfer(organizationId: string, actorId: string, dto: LeadTransferDto) {
    const dest = await this.prisma.userOrganization.findFirst({
      where: { organizationId, userId: dto.toUserId, isVirtual: false },
      select: { user: { select: { id: true, name: true } } },
    });
    if (!dest) throw new BadRequestException('Vendedor de destino não pertence a esta organização');

    const ids = [...new Set(dto.cardIds)];
    const expectedOwner =
      dto.fromUserId === undefined ? undefined : dto.fromUserId === NO_OWNER ? null : dto.fromUserId;

    const cards = await this.prisma.card.findMany({
      where: { id: { in: ids }, organizationId },
      select: { id: true, status: true, assignedToId: true, conversationId: true, contactId: true },
    });
    const found = new Set(cards.map((c) => c.id));
    const skipped: Array<{ cardId: string; reason: string }> = ids
      .filter((id) => !found.has(id))
      .map((cardId) => ({ cardId, reason: 'não encontrado' }));

    let conversationsUpdated = 0;
    const moved: string[] = [];
    for (const c of cards) {
      if (c.status !== 'OPEN') {
        skipped.push({ cardId: c.id, reason: 'lead fechado (ganho/perdido)' });
        continue;
      }
      if (c.assignedToId === dto.toUserId) {
        skipped.push({ cardId: c.id, reason: 'já é do vendedor de destino' });
        continue;
      }
      if (expectedOwner !== undefined && c.assignedToId !== expectedOwner) {
        skipped.push({ cardId: c.id, reason: 'mudou de vendedor depois da prévia' });
        continue;
      }
      try {
        // Trava otimista: só troca se o dono ainda é o mesmo que lemos.
        const res = await this.prisma.card.updateMany({
          where: { id: c.id, organizationId, status: 'OPEN', assignedToId: c.assignedToId },
          data: { assignedToId: dto.toUserId },
        });
        if (!res.count) {
          skipped.push({ cardId: c.id, reason: 'mudou de vendedor durante a transferência' });
          continue;
        }
        moved.push(c.id);
        conversationsUpdated += await syncConversationsWithCard(
          this.prisma,
          organizationId,
          { conversationId: c.conversationId, contactId: c.contactId },
          dto.toUserId,
          actorId,
          'lead_transfer',
        );
        const card = await this.prisma.card.findUnique({
          where: { id: c.id },
          include: {
            contact: { select: { id: true, name: true, phone: true, avatarUrl: true } },
            assignedTo: { select: { id: true, name: true, avatarUrl: true } },
          },
        });
        if (card) this.realtime.emitToOrg(organizationId, 'card:updated', { card });
      } catch (err: any) {
        this.logger.warn(`lead_transfer falhou no card ${c.id}: ${err?.message ?? err}`);
        skipped.push({ cardId: c.id, reason: 'erro ao transferir' });
      }
    }
    if (conversationsUpdated) this.realtime.emitToOrg(organizationId, 'conversation:updated', {});

    if (moved.length) {
      const names = await this.prisma.user.findMany({
        where: { id: { in: [actorId, ...(expectedOwner ? [expectedOwner] : [])] } },
        select: { id: true, name: true },
      });
      const nameOf = (id?: string | null) => names.find((u) => u.id === id)?.name ?? null;
      const fromName = expectedOwner ? nameOf(expectedOwner) : null;
      const n = moved.length;
      await this.notifications
        .notify({
          recipientId: dto.toUserId,
          organizationId,
          type: NotificationType.CONVERSATION_TRANSFERRED,
          title: `${n} lead${n > 1 ? 's' : ''} transferido${n > 1 ? 's' : ''} para você`,
          body:
            `${nameOf(actorId) ?? 'Um gestor'} transferiu ${n} lead${n > 1 ? 's' : ''}` +
            `${fromName ? ` de ${fromName}` : ''} para o seu atendimento.`,
          data: { source: 'lead_transfer', cardIds: moved },
        })
        .catch((err: any) => this.logger.warn(`notificação de transferência falhou: ${err?.message ?? err}`));
    }

    this.logger.log(
      `lead_transfer org=${organizationId} por=${actorId} de=${dto.fromUserId ?? '-'} para=${dto.toUserId} ` +
        `ok=${moved.length} convs=${conversationsUpdated} pulados=${skipped.length}`,
    );
    return { transferred: moved.length, conversationsUpdated, skipped };
  }
}
