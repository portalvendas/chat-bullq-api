import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { CardStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { CommercialRoutineService } from '../commercial-routine/commercial-routine.service';
import {
  PRODUCTIVITY_TZ,
  dayBoundsUtc,
  firstNameToken,
  isValidDay,
  localDay,
  sqlUtc,
} from './productivity.time';

/**
 * Painel de produtividade dos vendedores — agregação 100% no servidor.
 *
 * Fontes por vendedor/dia:
 *  - Presença (tempo de tela): user_activity_minutes (heartbeat do navegador).
 *  - Atendimento: messages OUTBOUND com sender_id (enviadas pelo CRM) +
 *    ecos do celular (sender_id nulo, metadata.isEcho) nos números cujo
 *    channels.owner_user_id é o vendedor. "Tempo em atendimento" = sessões de
 *    envio (mensagens a ≤10 min uma da outra), o que inclui o trabalho feito
 *    pelo celular.
 *  - Tempo de resposta: para cada vez que o cliente fala (início do turno),
 *    a 1ª resposta humana atribuível; mediana por vendedor.
 *  - Funil: card_events (movimentos com autor) + cards criados/fechados do
 *    vendedor.
 *  - Vendas: tiny_documents do dia pelo 1º nome do vendedor do Tiny.
 *  - Rotina: marcações em routine_daily_checks.
 */

const SESSION_GAP_MIN = 10;
const PENDING_AFTER_MIN = 15;
// Constantes de código (não vêm do usuário) → seguras como SQL literal.
const SESSION_GAP = Prisma.raw(`interval '${SESSION_GAP_MIN} minutes'`);
const PENDING_AFTER = Prisma.raw(`interval '${PENDING_AFTER_MIN} minutes'`);
const PEDIDO_EXCLUIDOS = new Set(['Cancelada', 'Dados Incompletos', 'Removido']);

type Num = number | null;

export interface SellerDailyRow {
  userId: string;
  name: string;
  avatarUrl: string | null;
  role: string;
  presence: {
    firstSeen: string | null;
    firstActive: string | null;
    lastActive: string | null;
    lastSeen: string | null;
    activeMinutes: number;
    idleMinutes: number;
    backgroundMinutes: number;
    conversationMinutes: number;
    longestBreakMinutes: number;
    areas: { area: string; minutes: number }[];
  };
  service: {
    messagesCrm: number;
    messagesPhone: number;
    conversations: number;
    talkMinutes: number;
    firstMessageAt: string | null;
    lastMessageAt: string | null;
    responses: number;
    responseMedianSec: Num;
    respondedWithin15: number;
    pendingNow: Num;
  };
  funnel: { cardsMoved: number; newLeads: number; won: number; lost: number };
  sales: { quotes: number; quotesValue: number; orders: number; ordersValue: number };
  routine: { active: boolean; checked: number; total: number };
  /** Começou o dia (1º minuto em uso no CRM ou 1ª mensagem, o que vier antes). */
  dayStart: string | null;
  hasActivity: boolean;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const minDate = (...ds: (Date | null | undefined)[]) =>
  ds.filter(Boolean).sort((a, b) => a!.getTime() - b!.getTime())[0] ?? null;

@Injectable()
export class ProductivityReportService {
  private readonly logger = new Logger(ProductivityReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly routine: CommercialRoutineService,
  ) {}

  private resolveDay(day?: string): string {
    if (!day) return localDay();
    if (!isValidDay(day)) throw new BadRequestException('day deve ser YYYY-MM-DD');
    return day;
  }

  /**
   * Resumo do dia por vendedor.
   *
   * GET /productivity/daily?day=2026-10-19 →
   * { day, timezone, generatedAt, isToday, totals: {...}, users: SellerDailyRow[],
   *   unmappedSellers: ['Fulano'] }
   */
  async daily(organizationId: string, dayParam?: string, onlyUserId?: string) {
    const day = this.resolveDay(dayParam);
    const { start, end } = dayBoundsUtc(day);
    const isToday = day === localDay();

    const members = await this.prisma.userOrganization.findMany({
      where: {
        organizationId,
        ...(onlyUserId ? { userId: onlyUserId } : {}),
        user: { isActive: true, deletedAt: null },
      },
      select: {
        role: true,
        user: { select: { id: true, name: true, avatarUrl: true } },
      },
    });

    const [presence, breaks, areas, msgs, responses, pending, funnel, sales, routine] =
      await Promise.all([
        this.presenceByUser(organizationId, day),
        this.longestBreakByUser(organizationId, day),
        this.areasByUser(organizationId, day),
        this.messagesByUser(organizationId, start, end),
        this.responseTimeByUser(organizationId, start, end),
        isToday ? this.pendingNowByUser(organizationId) : Promise.resolve(null),
        this.funnelByUser(organizationId, start, end),
        this.salesByUser(organizationId, start, end, members.map((m) => m.user)),
        this.routineByUser(organizationId, day),
      ]);

    const users: SellerDailyRow[] = members.map(({ role, user }) => {
      const p = presence.get(user.id);
      const m = msgs.get(user.id);
      const r = responses.get(user.id);
      const f = funnel.get(user.id);
      const s = sales.byUser.get(user.id);
      const firstSeen = p?.firstSeen ?? null;
      // Início do dia = 1º minuto EM USO no CRM ou 1ª mensagem (inclui celular).
      // Aba aberta em segundo plano não conta como começar a trabalhar.
      const dayStart = minDate(p?.firstActive ?? null, m?.firstMessageAt ?? null);
      const row: SellerDailyRow = {
        userId: user.id,
        name: user.name,
        avatarUrl: user.avatarUrl ?? null,
        role,
        presence: {
          firstSeen: iso(firstSeen),
          firstActive: iso(p?.firstActive),
          lastActive: iso(p?.lastActive),
          lastSeen: iso(p?.lastSeen),
          activeMinutes: p?.activeMin ?? 0,
          idleMinutes: p?.idleMin ?? 0,
          backgroundMinutes: p?.backgroundMin ?? 0,
          conversationMinutes: p?.conversationMin ?? 0,
          longestBreakMinutes: breaks.get(user.id) ?? 0,
          areas: (areas.get(user.id) ?? []).sort((a, b) => b.minutes - a.minutes),
        },
        service: {
          messagesCrm: m?.messagesCrm ?? 0,
          messagesPhone: m?.messagesPhone ?? 0,
          conversations: m?.conversations ?? 0,
          talkMinutes: m?.talkMin ?? 0,
          firstMessageAt: iso(m?.firstMessageAt),
          lastMessageAt: iso(m?.lastMessageAt),
          responses: r?.responses ?? 0,
          responseMedianSec: r?.medianSec != null ? Math.round(r.medianSec) : null,
          respondedWithin15: r?.within15 ?? 0,
          pendingNow: pending ? (pending.get(user.id) ?? 0) : null,
        },
        funnel: {
          cardsMoved: f?.cardsMoved ?? 0,
          newLeads: f?.newLeads ?? 0,
          won: f?.won ?? 0,
          lost: f?.lost ?? 0,
        },
        sales: s ?? { quotes: 0, quotesValue: 0, orders: 0, ordersValue: 0 },
        routine: routine.byUser(user.id),
        dayStart: iso(dayStart),
        hasActivity: false,
      };
      row.hasActivity =
        !!dayStart ||
        row.funnel.cardsMoved + row.sales.quotes + row.sales.orders + row.routine.checked > 0;
      return row;
    });

    // Quem trabalhou primeiro (sem atividade vai pro fim, por nome).
    users.sort((a, b) => {
      if (a.dayStart && b.dayStart) return a.dayStart.localeCompare(b.dayStart);
      if (a.dayStart) return -1;
      if (b.dayStart) return 1;
      return a.name.localeCompare(b.name);
    });

    const sum = (f: (u: SellerDailyRow) => number) => users.reduce((acc, u) => acc + f(u), 0);
    return {
      day,
      timezone: PRODUCTIVITY_TZ,
      isToday,
      generatedAt: new Date().toISOString(),
      totals: {
        activeSellers: users.filter((u) => u.hasActivity).length,
        activeMinutes: sum((u) => u.presence.activeMinutes),
        talkMinutes: sum((u) => u.service.talkMinutes),
        messages: sum((u) => u.service.messagesCrm + u.service.messagesPhone),
        conversations: sum((u) => u.service.conversations),
        cardsMoved: sum((u) => u.funnel.cardsMoved),
        quotes: sum((u) => u.sales.quotes),
        quotesValue: Math.round(sum((u) => u.sales.quotesValue) * 100) / 100,
        orders: sum((u) => u.sales.orders),
        ordersValue: Math.round(sum((u) => u.sales.ordersValue) * 100) / 100,
      },
      users,
      unmappedSellers: sales.unmapped,
    };
  }

  /**
   * Indicador INDIVIDUAL do próprio vendedor (dashboard dele). Só devolve os
   * números de quem pediu — nunca os da equipe nem totais.
   *
   * GET /productivity/me?day=2026-10-19 →
   * { day, isToday, generatedAt, me: SellerDailyRow, timeline: {...} }
   */
  async me(organizationId: string, userId: string, dayParam?: string) {
    const [d, timeline] = await Promise.all([
      this.daily(organizationId, dayParam, userId),
      this.timeline(organizationId, userId, dayParam),
    ]);
    const me = d.users[0];
    if (!me) throw new NotFoundException('Usuário não encontrado nesta empresa');
    return {
      day: d.day,
      timezone: d.timezone,
      isToday: d.isToday,
      generatedAt: d.generatedAt,
      me,
      timeline: { segments: timeline.segments, hourly: timeline.hourly, cardEvents: timeline.cardEvents },
    };
  }

  /**
   * Linha do tempo de UM vendedor no dia.
   *
   * GET /productivity/timeline?day=2026-10-19&userId=… →
   * { day, segments: [{start,end,state}], hourly: [{hour, crm, phone}],
   *   cardEvents: [{at,type,cardTitle,fromStage,toStage}] }
   */
  async timeline(organizationId: string, userId: string, dayParam?: string) {
    const day = this.resolveDay(dayParam);
    const { start, end } = dayBoundsUtc(day);
    const member = await this.prisma.userOrganization.findFirst({
      where: { organizationId, userId },
      select: { user: { select: { id: true, name: true } } },
    });
    if (!member) throw new NotFoundException('Vendedor não encontrado nesta empresa');

    const minutes = await this.prisma.$queryRaw<{ minuteAt: Date; state: number }[]>`
      SELECT minute_at AS "minuteAt", state::int AS state
      FROM user_activity_minutes
      WHERE organization_id = ${organizationId} AND user_id = ${userId} AND day = ${day}
      ORDER BY minute_at`;

    const STATE = ['offline', 'background', 'idle', 'active'] as const;
    const segments: { start: string; end: string; state: (typeof STATE)[number] }[] = [];
    let cur: { start: Date; end: Date; state: number } | null = null;
    for (const row of minutes) {
      const t = new Date(row.minuteAt);
      const contiguous = cur && t.getTime() === cur.end.getTime();
      if (cur && contiguous && cur.state === row.state) {
        cur.end = new Date(t.getTime() + 60000);
        continue;
      }
      if (cur) segments.push({ start: iso(cur.start)!, end: iso(cur.end)!, state: STATE[cur.state] });
      cur = { start: t, end: new Date(t.getTime() + 60000), state: row.state };
    }
    if (cur) segments.push({ start: iso(cur.start)!, end: iso(cur.end)!, state: STATE[cur.state] });

    const hourlyRows = await this.prisma.$queryRaw<{ hour: number; crm: number; phone: number }[]>`
      SELECT EXTRACT(HOUR FROM ((m.created_at AT TIME ZONE 'UTC') AT TIME ZONE ${PRODUCTIVITY_TZ}))::int AS hour,
             COUNT(*) FILTER (WHERE m.sender_id IS NOT NULL)::int AS crm,
             COUNT(*) FILTER (WHERE m.sender_id IS NULL)::int AS phone
      FROM messages m
      JOIN conversations c ON c.id = m.conversation_id
      JOIN channels ch ON ch.id = c.channel_id
      WHERE c.organization_id = ${organizationId} AND c.is_group = false
        AND m.direction = 'OUTBOUND'
        AND m.created_at >= ${sqlUtc(start)} AND m.created_at < ${sqlUtc(end)}
        AND (m.sender_id = ${userId}
             OR (m.sender_id IS NULL AND m.metadata->>'isEcho' = 'true' AND ch.owner_user_id = ${userId}))
      GROUP BY 1`;
    const byHour = new Map(hourlyRows.map((h) => [h.hour, h]));
    const hourly = Array.from({ length: 24 }, (_, hour) => ({
      hour,
      crm: byHour.get(hour)?.crm ?? 0,
      phone: byHour.get(hour)?.phone ?? 0,
    }));

    const events = await this.prisma.cardEvent.findMany({
      where: { organizationId, userId, createdAt: { gte: start, lt: end } },
      orderBy: { createdAt: 'asc' },
      take: 300,
      select: { createdAt: true, type: true, cardId: true, fromStageId: true, toStageId: true },
    });
    const stageIds = [...new Set(events.flatMap((e) => [e.fromStageId, e.toStageId]).filter(Boolean))] as string[];
    const cardIds = [...new Set(events.map((e) => e.cardId))];
    const [stages, cards] = await Promise.all([
      stageIds.length
        ? this.prisma.pipelineStage.findMany({ where: { id: { in: stageIds } }, select: { id: true, name: true } })
        : [],
      cardIds.length
        ? this.prisma.card.findMany({
            where: { organizationId, id: { in: cardIds } },
            select: { id: true, title: true },
          })
        : [],
    ]);
    const stageName = new Map(stages.map((s) => [s.id, s.name]));
    const cardTitle = new Map(cards.map((c) => [c.id, c.title]));

    return {
      day,
      timezone: PRODUCTIVITY_TZ,
      user: member.user,
      segments,
      hourly,
      cardEvents: events.map((e) => ({
        at: e.createdAt.toISOString(),
        type: e.type,
        cardId: e.cardId,
        cardTitle: cardTitle.get(e.cardId) ?? null,
        fromStage: e.fromStageId ? (stageName.get(e.fromStageId) ?? null) : null,
        toStage: e.toStageId ? (stageName.get(e.toStageId) ?? null) : null,
      })),
    };
  }

  // ── Fontes ─────────────────────────────────────────────────────────

  private async presenceByUser(organizationId: string, day: string) {
    const rows = await this.prisma.$queryRaw<
      {
        userId: string;
        firstSeen: Date;
        firstActive: Date | null;
        lastActive: Date | null;
        lastSeen: Date;
        activeMin: number;
        idleMin: number;
        backgroundMin: number;
        conversationMin: number;
      }[]
    >`
      SELECT user_id AS "userId",
             MIN(minute_at) AS "firstSeen",
             MIN(minute_at) FILTER (WHERE state = 3) AS "firstActive",
             MAX(minute_at) FILTER (WHERE state = 3) AS "lastActive",
             MAX(minute_at) AS "lastSeen",
             COUNT(*) FILTER (WHERE state = 3)::int AS "activeMin",
             COUNT(*) FILTER (WHERE state = 2)::int AS "idleMin",
             COUNT(*) FILTER (WHERE state = 1)::int AS "backgroundMin",
             COUNT(*) FILTER (WHERE state = 3 AND conversation_id IS NOT NULL)::int AS "conversationMin"
      FROM user_activity_minutes
      WHERE organization_id = ${organizationId} AND day = ${day}
      GROUP BY user_id`;
    return new Map(rows.map((r) => [r.userId, r]));
  }

  /** Maior intervalo entre dois minutos "em uso" (pausa mais longa do dia). */
  private async longestBreakByUser(organizationId: string, day: string) {
    const rows = await this.prisma.$queryRaw<{ userId: string; minutes: number }[]>`
      SELECT user_id AS "userId",
             COALESCE(MAX(EXTRACT(EPOCH FROM (minute_at - prev)) / 60 - 1), 0)::int AS minutes
      FROM (
        SELECT user_id, minute_at,
               LAG(minute_at) OVER (PARTITION BY user_id ORDER BY minute_at) AS prev
        FROM user_activity_minutes
        WHERE organization_id = ${organizationId} AND day = ${day} AND state = 3
      ) t
      GROUP BY user_id`;
    return new Map(rows.map((r) => [r.userId, Math.max(0, r.minutes)]));
  }

  private async areasByUser(organizationId: string, day: string) {
    const rows = await this.prisma.$queryRaw<{ userId: string; area: string; minutes: number }[]>`
      SELECT user_id AS "userId", COALESCE(NULLIF(area, ''), 'outros') AS area, COUNT(*)::int AS minutes
      FROM user_activity_minutes
      WHERE organization_id = ${organizationId} AND day = ${day} AND state = 3
      GROUP BY 1, 2`;
    const out = new Map<string, { area: string; minutes: number }[]>();
    for (const r of rows) out.set(r.userId, [...(out.get(r.userId) ?? []), { area: r.area, minutes: r.minutes }]);
    return out;
  }

  /** Condição SQL "mensagem humana atribuível" (CRM ou eco do celular do dono do número). */
  private attributable(m: string, ch: string): Prisma.Sql {
    return Prisma.raw(
      `(${m}.sender_id IS NOT NULL OR (${m}.metadata->>'isEcho' = 'true' AND ${ch}.owner_user_id IS NOT NULL))`,
    );
  }

  private async messagesByUser(organizationId: string, start: Date, end: Date) {
    const rows = await this.prisma.$queryRaw<
      {
        userId: string;
        messagesCrm: number;
        messagesPhone: number;
        conversations: number;
        firstMessageAt: Date;
        lastMessageAt: Date;
        talkMin: number;
      }[]
    >`
      WITH att AS (
        SELECT COALESCE(m.sender_id, ch.owner_user_id) AS uid,
               (m.sender_id IS NULL) AS via_phone,
               m.conversation_id, m.created_at
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        JOIN channels ch ON ch.id = c.channel_id
        WHERE c.organization_id = ${organizationId} AND c.is_group = false
          AND m.direction = 'OUTBOUND'
          AND m.created_at >= ${sqlUtc(start)} AND m.created_at < ${sqlUtc(end)}
          AND ${this.attributable('m', 'ch')}
      ),
      s AS (
        SELECT uid, created_at,
               CASE WHEN created_at - LAG(created_at) OVER (PARTITION BY uid ORDER BY created_at)
                         <= ${SESSION_GAP} THEN 0 ELSE 1 END AS new_s
        FROM att
      ),
      g AS (
        SELECT uid, created_at,
               SUM(new_s) OVER (PARTITION BY uid ORDER BY created_at ROWS UNBOUNDED PRECEDING) AS sid
        FROM s
      ),
      sess AS (
        SELECT uid, SUM(EXTRACT(EPOCH FROM (mx - mn)) / 60 + 1) AS minutes
        FROM (SELECT uid, sid, MIN(created_at) AS mn, MAX(created_at) AS mx FROM g GROUP BY uid, sid) x
        GROUP BY uid
      )
      SELECT a.uid AS "userId",
             COUNT(*) FILTER (WHERE NOT a.via_phone)::int AS "messagesCrm",
             COUNT(*) FILTER (WHERE a.via_phone)::int AS "messagesPhone",
             COUNT(DISTINCT a.conversation_id)::int AS "conversations",
             MIN(a.created_at) AS "firstMessageAt",
             MAX(a.created_at) AS "lastMessageAt",
             COALESCE(MAX(sess.minutes), 0)::int AS "talkMin"
      FROM att a
      LEFT JOIN sess ON sess.uid = a.uid
      GROUP BY a.uid`;
    return new Map(rows.map((r) => [r.userId, r]));
  }

  /** Mediana do tempo até a 1ª resposta humana, por início de turno do cliente. */
  private async responseTimeByUser(organizationId: string, start: Date, end: Date) {
    const rows = await this.prisma.$queryRaw<
      { userId: string; medianSec: number | null; responses: number; within15: number }[]
    >`
      WITH conv AS (
        SELECT c.id, ch.owner_user_id
        FROM conversations c JOIN channels ch ON ch.id = c.channel_id
        WHERE c.organization_id = ${organizationId} AND c.is_group = false
      ),
      w AS (
        SELECT m.conversation_id, m.created_at, m.direction::text AS dir,
               LAG(m.direction::text) OVER (PARTITION BY m.conversation_id ORDER BY m.created_at) AS prev_dir
        FROM messages m JOIN conv ON conv.id = m.conversation_id
        WHERE m.created_at >= ${sqlUtc(start)} - interval '1 day' AND m.created_at < ${sqlUtc(end)}
      ),
      turns AS (
        SELECT conversation_id, created_at FROM w
        WHERE dir = 'INBOUND' AND prev_dir IS DISTINCT FROM 'INBOUND'
          AND created_at >= ${sqlUtc(start)} AND created_at < ${sqlUtc(end)}
      )
      SELECT r.uid AS "userId",
             percentile_cont(0.5) WITHIN GROUP (ORDER BY EXTRACT(EPOCH FROM (r.created_at - t.created_at)))::float8 AS "medianSec",
             COUNT(*)::int AS responses,
             COUNT(*) FILTER (WHERE r.created_at - t.created_at <= ${PENDING_AFTER})::int AS within15
      FROM turns t
      JOIN LATERAL (
        SELECT COALESCE(o.sender_id, cv.owner_user_id) AS uid, o.created_at
        FROM messages o JOIN conv cv ON cv.id = o.conversation_id
        WHERE o.conversation_id = t.conversation_id
          AND o.direction = 'OUTBOUND'
          AND o.created_at > t.created_at
          AND o.created_at < t.created_at + interval '2 days'
          AND ${this.attributable('o', 'cv')}
        ORDER BY o.created_at
        LIMIT 1
      ) r ON true
      GROUP BY r.uid`;
    return new Map(rows.map((r) => [r.userId, r]));
  }

  /** Conversas do vendedor com o cliente esperando (> 15 min) — só "agora". */
  private async pendingNowByUser(organizationId: string) {
    const rows = await this.prisma.$queryRaw<{ userId: string; pending: number }[]>`
      SELECT c.assigned_to_id AS "userId", COUNT(*)::int AS pending
      FROM conversations c
      JOIN LATERAL (
        SELECT m.direction::text AS dir, m.created_at
        FROM messages m WHERE m.conversation_id = c.id
        ORDER BY m.created_at DESC LIMIT 1
      ) lm ON true
      WHERE c.organization_id = ${organizationId}
        AND c.assigned_to_id IS NOT NULL
        AND c.deleted_at IS NULL AND c.is_archived = false AND c.is_group = false
        AND c.status <> 'CLOSED'
        AND c.last_message_at >= (now() AT TIME ZONE 'UTC') - interval '7 days'
        AND lm.dir = 'INBOUND'
        AND lm.created_at < (now() AT TIME ZONE 'UTC') - ${PENDING_AFTER}
      GROUP BY 1`;
    return new Map(rows.map((r) => [r.userId, r.pending]));
  }

  private async funnelByUser(organizationId: string, start: Date, end: Date) {
    const [moves, created, closed] = await Promise.all([
      this.prisma.cardEvent.groupBy({
        by: ['userId'],
        where: { organizationId, userId: { not: null }, createdAt: { gte: start, lt: end } },
        _count: { _all: true },
      }),
      this.prisma.card.groupBy({
        by: ['assignedToId'],
        where: { organizationId, assignedToId: { not: null }, createdAt: { gte: start, lt: end } },
        _count: { _all: true },
      }),
      this.prisma.card.groupBy({
        by: ['assignedToId', 'status'],
        where: {
          organizationId,
          assignedToId: { not: null },
          status: { in: [CardStatus.WON, CardStatus.LOST] },
          closedAt: { gte: start, lt: end },
        },
        _count: { _all: true },
      }),
    ]);
    const out = new Map<string, { cardsMoved: number; newLeads: number; won: number; lost: number }>();
    const get = (id: string) => {
      if (!out.has(id)) out.set(id, { cardsMoved: 0, newLeads: 0, won: 0, lost: 0 });
      return out.get(id)!;
    };
    for (const r of moves) if (r.userId) get(r.userId).cardsMoved += r._count._all;
    for (const r of created) if (r.assignedToId) get(r.assignedToId).newLeads += r._count._all;
    for (const r of closed) {
      if (!r.assignedToId) continue;
      if (r.status === CardStatus.WON) get(r.assignedToId).won += r._count._all;
      else get(r.assignedToId).lost += r._count._all;
    }
    return out;
  }

  /**
   * Orçamentos e pedidos (venda efetiva) do dia por vendedor. O Tiny só traz o
   * NOME do vendedor: casamos pelo 1º nome com os usuários da org (só quando
   * o 1º nome é único). Nomes sem usuário voltam em `unmapped`.
   */
  private async salesByUser(
    organizationId: string,
    start: Date,
    end: Date,
    users: { id: string; name: string }[],
  ) {
    const usersByFirst = new Map<string, string[]>();
    for (const u of users) {
      const f = firstNameToken(u.name);
      if (f) usersByFirst.set(f, [...(usersByFirst.get(f) ?? []), u.id]);
    }
    const docs = await this.prisma.tinyDocument.findMany({
      where: {
        organizationId,
        kind: { in: ['ORCAMENTO', 'PEDIDO'] },
        data: { gte: start, lt: end },
        vendedor: { not: null },
      },
      select: { kind: true, valor: true, vendedor: true, situacao: true, isMarketplace: true, natureza: true },
    });
    const byUser = new Map<string, { quotes: number; quotesValue: number; orders: number; ordersValue: number }>();
    const unmapped = new Set<string>();
    for (const d of docs) {
      const ids = usersByFirst.get(firstNameToken(d.vendedor) ?? '');
      if (!ids || ids.length !== 1) {
        if (d.vendedor) unmapped.add(d.vendedor);
        continue;
      }
      const acc = byUser.get(ids[0]) ?? { quotes: 0, quotesValue: 0, orders: 0, ordersValue: 0 };
      const v = d.valor ? Number(d.valor) : 0;
      if (d.kind === 'ORCAMENTO') {
        acc.quotes += 1;
        acc.quotesValue = Math.round((acc.quotesValue + v) * 100) / 100;
      } else if (
        !PEDIDO_EXCLUIDOS.has(String(d.situacao ?? '')) &&
        d.isMarketplace !== true &&
        /venda/i.test(String(d.natureza ?? ''))
      ) {
        acc.orders += 1;
        acc.ordersValue = Math.round((acc.ordersValue + v) * 100) / 100;
      }
      byUser.set(ids[0], acc);
    }
    return { byUser, unmapped: [...unmapped].sort() };
  }

  private async routineByUser(organizationId: string, day: string) {
    const [cfg, checks] = await Promise.all([
      this.routine.getConfig(organizationId).catch((err: any) => {
        this.logger.warn(`config da rotina indisponível: ${err?.message ?? err}`);
        return null;
      }),
      this.prisma.routineDailyCheck.groupBy({
        by: ['userId'],
        where: { organizationId, day },
        _count: { _all: true },
      }),
    ]);
    const byId = new Map(checks.map((c) => [c.userId, c._count._all]));
    const total = cfg?.steps?.length ?? 0;
    return {
      byUser: (userId: string) => ({
        active: !!cfg && cfg.enabled && (cfg.userMode === 'ALL' || cfg.userIds.includes(userId)),
        checked: byId.get(userId) ?? 0,
        total,
      }),
    };
  }
}
