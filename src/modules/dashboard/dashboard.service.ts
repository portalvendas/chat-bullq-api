import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export interface DateRange {
  from: Date;
  to: Date;
}

/** Formato de aiBusinessHours: { monday: { enabled, windows:[["09:00","18:00"]] }, ... }. */
type BusinessHoursConfig = Record<
  string,
  { enabled: boolean; windows?: Array<[string, string]> }
>;

const DTF_CACHE = new Map<string, Intl.DateTimeFormat>();
function tzFmt(tz: string): Intl.DateTimeFormat {
  let f = DTF_CACHE.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    DTF_CACHE.set(tz, f);
  }
  return f;
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(organizationId: string, range: DateRange) {
    const where = { organizationId, createdAt: { gte: range.from, lte: range.to } };
    const prevFrom = new Date(range.from.getTime() - (range.to.getTime() - range.from.getTime()));
    const prevWhere = { organizationId, createdAt: { gte: prevFrom, lte: range.from } };

    const [
      totalConversations,
      prevTotal,
      openConversations,
      pendingConversations,
      waitingConversations,
      botConversations,
      stuckConversations,
      totalMessages,
      prevMessages,
      closedInPeriod,
      prevClosedInPeriod,
    ] = await this.prisma.$transaction([
      this.prisma.conversation.count({ where }),
      this.prisma.conversation.count({ where: prevWhere }),
      this.prisma.conversation.count({ where: { organizationId, status: 'OPEN' } }),
      this.prisma.conversation.count({ where: { organizationId, status: 'PENDING' } }),
      this.prisma.conversation.count({ where: { organizationId, status: 'WAITING' } }),
      this.prisma.conversation.count({ where: { organizationId, status: 'BOT' } }),
      this.prisma.conversation.count({
        where: { organizationId, isStuck: true, deletedAt: null },
      }),
      this.prisma.message.count({ where: { conversation: { organizationId }, createdAt: { gte: range.from, lte: range.to } } }),
      this.prisma.message.count({ where: { conversation: { organizationId }, createdAt: { gte: prevFrom, lte: range.from } } }),
      this.prisma.conversation.count({
        where: { organizationId, status: 'CLOSED', closedAt: { gte: range.from, lte: range.to } },
      }),
      this.prisma.conversation.count({
        where: { organizationId, status: 'CLOSED', closedAt: { gte: prevFrom, lte: range.from } },
      }),
    ]);

    const [avgFirstResponse, prevAvgFirstResponse] = await Promise.all([
      this.getAvgFirstResponseTime(organizationId, range),
      this.getAvgFirstResponseTime(organizationId, { from: prevFrom, to: range.from }),
    ]);
    const avgResolution = await this.getAvgResolutionTime(organizationId, range);
    const [slaCompliance, prevSlaCompliance] = await Promise.all([
      this.getSlaCompliance(organizationId, range),
      this.getSlaCompliance(organizationId, { from: prevFrom, to: range.from }),
    ]);

    const [closedNoReopen, csatAgg, prevCsatAgg] = await Promise.all([
      this.prisma.conversation.count({
        where: {
          organizationId, status: 'CLOSED',
          closedAt: { gte: range.from, lte: range.to },
          reopenedCount: 0,
        },
      }),
      this.prisma.conversationRating.aggregate({
        where: { organizationId, respondedAt: { gte: range.from, lte: range.to } },
        _avg: { score: true },
        _count: { _all: true },
      }),
      this.prisma.conversationRating.aggregate({
        where: { organizationId, respondedAt: { gte: prevFrom, lte: range.from } },
        _avg: { score: true },
      }),
    ]);

    const fcrPercent =
      closedInPeriod > 0 ? Math.round((closedNoReopen / closedInPeriod) * 100) : null;
    const csatScore = csatAgg._avg.score !== null ? Math.round(csatAgg._avg.score * 10) / 10 : null;
    const prevCsatScore = prevCsatAgg._avg.score;
    const csatTrend =
      csatScore !== null && prevCsatScore !== null
        ? Math.round((csatScore - prevCsatScore) * 10) / 10
        : 0;

    const activeConversations = openConversations + pendingConversations + waitingConversations;

    const resolutionRatePercent =
      totalConversations > 0 ? Math.round((closedInPeriod / totalConversations) * 100) : null;
    const prevResolutionRatePercent = prevTotal > 0 ? (prevClosedInPeriod / prevTotal) * 100 : null;

    return {
      activeConversations,
      activeBreakdown: {
        pending: pendingConversations,
        open: openConversations,
        waiting: waitingConversations,
        bot: botConversations,
      },
      stuckConversations,

      avgFirstResponseMinutes: avgFirstResponse,
      avgFirstResponseTrend:
        avgFirstResponse !== null && prevAvgFirstResponse !== null
          ? this.calcTrend(avgFirstResponse, prevAvgFirstResponse)
          : 0,

      slaCompliancePercent: slaCompliance,
      slaTrend:
        slaCompliance !== null && prevSlaCompliance !== null
          ? slaCompliance - prevSlaCompliance
          : 0,

      resolutionRatePercent,
      resolutionTrend:
        resolutionRatePercent !== null && prevResolutionRatePercent !== null
          ? Math.round(resolutionRatePercent - prevResolutionRatePercent)
          : 0,

      fcrPercent,
      csatScore,
      csatResponses: csatAgg._count._all,
      csatTrend,

      totalConversations,
      conversationsTrend: this.calcTrend(totalConversations, prevTotal),
      openConversations,
      pendingConversations,
      totalMessages,
      messagesTrend: this.calcTrend(totalMessages, prevMessages),
      avgResolutionMinutes: avgResolution,
    };
  }

  async getKpiSparklines(organizationId: string, range: DateRange) {
    const dept = await this.prisma.department.findFirst({
      where: { organizationId, isDefault: true },
      select: { slaFirstResponse: true },
    });
    const slaMinutes = dept?.slaFirstResponse ?? null;

    const conversations = await this.prisma.conversation.findMany({
      where: { organizationId, createdAt: { gte: range.from, lte: range.to } },
      select: { createdAt: true, firstResponseAt: true, closedAt: true, status: true },
    });

    const dayKeys = this.eachDay(range.from, range.to);
    const buckets = new Map<
      string,
      { created: number; closed: number; tmrSum: number; tmrCount: number; slaWithin: number; slaCount: number }
    >();
    for (const k of dayKeys) {
      buckets.set(k, { created: 0, closed: 0, tmrSum: 0, tmrCount: 0, slaWithin: 0, slaCount: 0 });
    }

    for (const c of conversations) {
      const k = c.createdAt.toISOString().slice(0, 10);
      const b = buckets.get(k);
      if (!b) continue;
      b.created++;
      if (c.firstResponseAt) {
        const minutes = (c.firstResponseAt.getTime() - c.createdAt.getTime()) / 60000;
        b.tmrSum += minutes;
        b.tmrCount++;
        if (slaMinutes !== null) {
          b.slaCount++;
          if (minutes <= slaMinutes) b.slaWithin++;
        }
      }
      if (c.status === 'CLOSED' && c.closedAt && c.closedAt >= range.from && c.closedAt <= range.to) {
        b.closed++;
      }
    }

    const active = dayKeys.map((d) => ({ date: d, value: buckets.get(d)!.created }));
    const firstResponse = dayKeys.map((d) => {
      const b = buckets.get(d)!;
      return { date: d, value: b.tmrCount > 0 ? Math.round(b.tmrSum / b.tmrCount) : 0 };
    });
    const sla = dayKeys.map((d) => {
      const b = buckets.get(d)!;
      return { date: d, value: b.slaCount > 0 ? Math.round((b.slaWithin / b.slaCount) * 100) : 0 };
    });
    const resolution = dayKeys.map((d) => {
      const b = buckets.get(d)!;
      return { date: d, value: b.created > 0 ? Math.round((b.closed / b.created) * 100) : 0 };
    });

    return { active, firstResponse, sla, resolution };
  }

  async getCsatBreakdown(organizationId: string, range: DateRange) {
    const [agg, ratings, recent] = await Promise.all([
      this.prisma.conversationRating.aggregate({
        where: { organizationId, respondedAt: { gte: range.from, lte: range.to } },
        _avg: { score: true },
        _count: { _all: true },
      }),
      this.prisma.conversationRating.groupBy({
        by: ['score'],
        where: { organizationId, respondedAt: { gte: range.from, lte: range.to } },
        _count: true,
      }),
      this.prisma.conversationRating.findMany({
        where: {
          organizationId,
          respondedAt: { gte: range.from, lte: range.to },
          comment: { not: null },
        },
        orderBy: { respondedAt: 'desc' },
        take: 5,
        select: {
          id: true, score: true, comment: true, respondedAt: true,
          conversation: { select: { contact: { select: { name: true } } } },
        },
      }),
    ]);

    const totalRequested = await this.prisma.conversationRating.count({
      where: { organizationId, requestedAt: { gte: range.from, lte: range.to } },
    });

    const distribution: Record<number, number> = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    for (const r of ratings) distribution[r.score] = r._count;

    return {
      avgScore: agg._avg.score !== null ? Math.round(agg._avg.score * 10) / 10 : null,
      totalResponses: agg._count._all,
      totalRequested,
      responseRate: totalRequested > 0
        ? Math.round((agg._count._all / totalRequested) * 100)
        : null,
      distribution,
      recentComments: recent.map((r) => ({
        id: r.id,
        score: r.score,
        comment: r.comment,
        respondedAt: r.respondedAt,
        contactName: r.conversation.contact.name,
      })),
    };
  }

  async getReopens(organizationId: string, range: DateRange) {
    const reopened = await this.prisma.conversation.findMany({
      where: {
        organizationId,
        reopenedCount: { gt: 0 },
        reopenedAt: { gte: range.from, lte: range.to },
      },
      select: {
        id: true,
        reopenedAt: true,
        reopenedCount: true,
        assignedTo: { select: { id: true, name: true } },
        contact: { select: { id: true, name: true } },
      },
    });

    const closedInPeriod = await this.prisma.conversation.count({
      where: { organizationId, status: 'CLOSED', closedAt: { gte: range.from, lte: range.to } },
    });

    const dayKeys = this.eachDay(range.from, range.to);
    const series = new Map<string, number>(dayKeys.map((d) => [d, 0]));
    for (const c of reopened) {
      if (!c.reopenedAt) continue;
      const k = c.reopenedAt.toISOString().slice(0, 10);
      if (series.has(k)) series.set(k, series.get(k)! + 1);
    }

    const totalReopens = reopened.reduce((s, r) => s + r.reopenedCount, 0);
    const reopenRate = closedInPeriod > 0
      ? Math.round((reopened.length / (closedInPeriod + reopened.length)) * 100)
      : null;

    return {
      totalReopens,
      uniqueConversationsReopened: reopened.length,
      reopenRate,
      series: dayKeys.map((d) => ({ date: d, value: series.get(d)! })),
      worstOffenders: reopened
        .sort((a, b) => b.reopenedCount - a.reopenedCount)
        .slice(0, 5)
        .map((c) => ({
          conversationId: c.id,
          contactName: c.contact.name,
          agentName: c.assignedTo?.name ?? null,
          reopenedCount: c.reopenedCount,
        })),
    };
  }

  private eachDay(from: Date, to: Date): string[] {
    const days: string[] = [];
    const cur = new Date(from);
    cur.setUTCHours(0, 0, 0, 0);
    const end = new Date(to);
    end.setUTCHours(0, 0, 0, 0);
    while (cur <= end) {
      days.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    return days;
  }

  async getVolumeByDay(organizationId: string, range: DateRange) {
    const conversations = await this.prisma.conversation.findMany({
      where: { organizationId, createdAt: { gte: range.from, lte: range.to } },
      select: { createdAt: true },
    });

    const byDay = new Map<string, number>();
    for (const c of conversations) {
      const day = c.createdAt.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);
    }

    return Array.from(byDay.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  /**
   * Métrica de Marketplaces (Mercado Livre e futuros): total de perguntas e
   * quantas foram respondidas pela IA vs por usuário (operador via BullQ ou
   * resposta dada direto no painel do ML). SQL raw pra evitar a fragilidade
   * de filtro JSON no Prisma quando a chave não existe.
   */
  async getMarketplaceStats(organizationId: string): Promise<{
    totalPerguntas: number;
    respondidas: number;
    emAberto: number;
    porIa: number;
    porUsuario: number;
    editadasPorUsuario: number;
  }> {
    const [rows, editRows] = await Promise.all([
      this.prisma.$queryRaw<
        {
          total_perguntas: number;
          respondidas: number;
          por_ia: number;
          por_usuario: number;
        }[]
      >`
        SELECT
          count(*) FILTER (WHERE m.direction = 'INBOUND')::int AS total_perguntas,
          count(*) FILTER (WHERE m.direction = 'INBOUND' AND (m.metadata->>'mlAnswered') = 'true')::int AS respondidas,
          count(*) FILTER (WHERE m.direction = 'OUTBOUND' AND (m.metadata->>'aiAgentId') IS NOT NULL)::int AS por_ia,
          count(*) FILTER (WHERE m.direction = 'OUTBOUND' AND (
            (m.metadata->>'mlExternalAnswer') = 'true'
            OR (m.sender_id IS NOT NULL AND (m.metadata->>'aiAgentId') IS NULL)
          ))::int AS por_usuario
        FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        JOIN channels ch ON ch.id = c.channel_id
        WHERE ch.organization_id = ${organizationId}
          AND ch.type = 'MERCADO_LIVRE'
          AND m.type = 'TEXT'
      `,
      // Respostas da IA que o operador EDITOU antes de aprovar. Fica na
      // pending action (args.editedByHuman), não na mensagem enviada.
      this.prisma.$queryRaw<{ editadas: number }[]>`
        SELECT count(*)::int AS editadas
        FROM ai_pending_actions pa
        JOIN conversations c ON c.id = pa.conversation_id
        JOIN channels ch ON ch.id = c.channel_id
        WHERE ch.organization_id = ${organizationId}
          AND ch.type = 'MERCADO_LIVRE'
          AND pa.tool_name = 'replyToConversation'
          AND (pa.args->>'editedByHuman') = 'true'
          AND pa.status IN ('APPROVED', 'EXECUTED')
      `,
    ]);
    const r = rows[0] ?? {
      total_perguntas: 0,
      respondidas: 0,
      por_ia: 0,
      por_usuario: 0,
    };
    return {
      totalPerguntas: r.total_perguntas,
      respondidas: r.respondidas,
      emAberto: Math.max(r.total_perguntas - r.respondidas, 0),
      porIa: r.por_ia,
      porUsuario: r.por_usuario,
      editadasPorUsuario: editRows[0]?.editadas ?? 0,
    };
  }

  /**
   * DASHBOARD COMERCIAL (Fase 1 — 100% nativo, sem dependência externa).
   * Cruza Leads (cards) × Origem × Campanha com Orçamentos/Pedidos (Tiny ERP),
   * qualidade (avanço no funil + leadScore/temperatura + gerou orçamento/pedido)
   * e conversão. Agregação server-side em SQL (p95 baixo) — o frontend só renderiza.
   *
   * Origem   = metadata.source (landing_page, facebook_leadads…) ou 'organico'.
   * Campanha = metadata.tracking.utm_campaign OU metadata.campaignName (Lead Ads).
   * Qualificado = avançou da etapa de entrada OU leadScore>=40 OU virou orçamento/pedido OU ganho.
   *
   * Colunas de GASTO/CAC/ROAS ficam de fora (Fase 2 — Meta Ads API); o frontend
   * já reserva o espaço.
   */
  async getCommercial(organizationId: string, range: DateRange) {
    const { from, to } = range;

    const [overviewRows, tinyRows, originRows, campaignRows] = await Promise.all([
      // ── Cards (leads) + qualidade ──────────────────────────────
      this.prisma.$queryRaw<
        {
          leads: number;
          qualificados: number;
          avancaram: number;
          ganhos: number;
          perdidos: number;
          com_doc: number;
          quentes: number;
          mornos: number;
          frios: number;
          sem_score: number;
          valor_ganho: number;
        }[]
      >`
        WITH entry AS (
          SELECT pipeline_id, MIN("order") AS entry_order
          FROM pipeline_stages GROUP BY pipeline_id
        ),
        tiny AS (
          SELECT contact_id,
                 bool_or(kind = 'ORCAMENTO') AS ho,
                 bool_or(kind = 'PEDIDO') AS hp
          FROM tiny_documents
          WHERE organization_id = ${organizationId} AND contact_id IS NOT NULL
          GROUP BY contact_id
        ),
        base AS (
          SELECT c.id, c.status, c.value,
                 s."order" AS so, e.entry_order AS eo,
                 CASE WHEN (c.metadata->>'leadScore') ~ '^[0-9]+$'
                      THEN (c.metadata->>'leadScore')::int END AS ls,
                 COALESCE(t.ho, false) AS ho,
                 COALESCE(t.hp, false) AS hp
          FROM cards c
          JOIN pipeline_stages s ON s.id = c.stage_id
          JOIN entry e ON e.pipeline_id = c.pipeline_id
          LEFT JOIN tiny t ON t.contact_id = c.contact_id
          WHERE c.organization_id = ${organizationId}
            AND c.created_at BETWEEN ${from} AND ${to}
        )
        SELECT
          count(*)::int AS leads,
          count(*) FILTER (WHERE so > eo OR status = 'WON' OR ls >= 40 OR ho OR hp)::int AS qualificados,
          count(*) FILTER (WHERE so > eo)::int AS avancaram,
          count(*) FILTER (WHERE status = 'WON')::int AS ganhos,
          count(*) FILTER (WHERE status = 'LOST')::int AS perdidos,
          count(*) FILTER (WHERE ho OR hp)::int AS com_doc,
          count(*) FILTER (WHERE ls >= 70)::int AS quentes,
          count(*) FILTER (WHERE ls >= 40 AND ls < 70)::int AS mornos,
          count(*) FILTER (WHERE ls IS NOT NULL AND ls < 40)::int AS frios,
          count(*) FILTER (WHERE ls IS NULL)::int AS sem_score,
          COALESCE(sum(value) FILTER (WHERE status = 'WON'), 0)::float8 AS valor_ganho
        FROM base
      `,
      // ── Orçamentos / Pedidos (Tiny) no período ─────────────────
      this.prisma.$queryRaw<
        {
          orcamentos: number;
          orcamentos_valor: number;
          pedidos: number;
          pedidos_valor: number;
        }[]
      >`
        SELECT
          count(*) FILTER (WHERE kind = 'ORCAMENTO')::int AS orcamentos,
          COALESCE(sum(valor) FILTER (WHERE kind = 'ORCAMENTO'), 0)::float8 AS orcamentos_valor,
          count(*) FILTER (WHERE kind = 'PEDIDO')::int AS pedidos,
          COALESCE(sum(valor) FILTER (WHERE kind = 'PEDIDO'), 0)::float8 AS pedidos_valor
        FROM tiny_documents
        WHERE organization_id = ${organizationId}
          AND data BETWEEN ${from} AND ${to}
      `,
      // ── Por ORIGEM ─────────────────────────────────────────────
      this.prisma.$queryRaw<
        {
          origem: string;
          leads: number;
          ganhos: number;
          orcamentos: number;
          pedidos: number;
          valor_ganho: number;
        }[]
      >`
        WITH tiny AS (
          SELECT contact_id,
                 bool_or(kind = 'ORCAMENTO') AS ho,
                 bool_or(kind = 'PEDIDO') AS hp
          FROM tiny_documents
          WHERE organization_id = ${organizationId} AND contact_id IS NOT NULL
          GROUP BY contact_id
        )
        SELECT
          COALESCE(NULLIF(c.metadata->>'source', ''), 'organico') AS origem,
          count(*)::int AS leads,
          count(*) FILTER (WHERE c.status = 'WON')::int AS ganhos,
          count(*) FILTER (WHERE COALESCE(t.ho, false))::int AS orcamentos,
          count(*) FILTER (WHERE COALESCE(t.hp, false))::int AS pedidos,
          COALESCE(sum(c.value) FILTER (WHERE c.status = 'WON'), 0)::float8 AS valor_ganho
        FROM cards c
        LEFT JOIN tiny t ON t.contact_id = c.contact_id
        WHERE c.organization_id = ${organizationId}
          AND c.created_at BETWEEN ${from} AND ${to}
        GROUP BY 1
        ORDER BY leads DESC
        LIMIT 20
      `,
      // ── Por CAMPANHA ───────────────────────────────────────────
      this.prisma.$queryRaw<
        {
          campanha: string;
          leads: number;
          ganhos: number;
          orcamentos: number;
          pedidos: number;
          valor_ganho: number;
        }[]
      >`
        WITH tiny AS (
          SELECT contact_id,
                 bool_or(kind = 'ORCAMENTO') AS ho,
                 bool_or(kind = 'PEDIDO') AS hp
          FROM tiny_documents
          WHERE organization_id = ${organizationId} AND contact_id IS NOT NULL
          GROUP BY contact_id
        )
        SELECT
          COALESCE(
            NULLIF(c.metadata->'tracking'->>'utm_campaign', ''),
            NULLIF(c.metadata->>'campaignName', ''),
            '(sem campanha)'
          ) AS campanha,
          count(*)::int AS leads,
          count(*) FILTER (WHERE c.status = 'WON')::int AS ganhos,
          count(*) FILTER (WHERE COALESCE(t.ho, false))::int AS orcamentos,
          count(*) FILTER (WHERE COALESCE(t.hp, false))::int AS pedidos,
          COALESCE(sum(c.value) FILTER (WHERE c.status = 'WON'), 0)::float8 AS valor_ganho
        FROM cards c
        LEFT JOIN tiny t ON t.contact_id = c.contact_id
        WHERE c.organization_id = ${organizationId}
          AND c.created_at BETWEEN ${from} AND ${to}
        GROUP BY 1
        ORDER BY leads DESC
        LIMIT 20
      `,
    ]);

    const o = overviewRows[0] ?? {
      leads: 0, qualificados: 0, avancaram: 0, ganhos: 0, perdidos: 0,
      com_doc: 0, quentes: 0, mornos: 0, frios: 0, sem_score: 0, valor_ganho: 0,
    };
    const t = tinyRows[0] ?? {
      orcamentos: 0, orcamentos_valor: 0, pedidos: 0, pedidos_valor: 0,
    };

    const pct = (num: number, den: number) =>
      den > 0 ? Math.round((num / den) * 1000) / 10 : 0;

    return {
      overview: {
        leads: o.leads,
        qualificados: o.qualificados,
        qualificadosPct: pct(o.qualificados, o.leads),
        orcamentos: t.orcamentos,
        orcamentosValor: t.orcamentos_valor,
        pedidos: t.pedidos,
        pedidosValor: t.pedidos_valor,
        ganhos: o.ganhos,
        perdidos: o.perdidos,
        valorGanho: o.valor_ganho,
        ticketMedio: t.pedidos > 0 ? Math.round((t.pedidos_valor / t.pedidos) * 100) / 100 : 0,
        gasto: null as number | null,
        cac: null as number | null,
        roas: null as number | null,
      },
      funnel: {
        leads: o.leads,
        orcamentos: t.orcamentos,
        pedidos: t.pedidos,
        leadParaOrcamentoPct: pct(t.orcamentos, o.leads),
        orcamentoParaPedidoPct: pct(t.pedidos, t.orcamentos),
        leadParaPedidoPct: pct(t.pedidos, o.leads),
      },
      quality: {
        avancaram: o.avancaram,
        naoAvancaram: Math.max(o.leads - o.avancaram, 0),
        comOrcamentoOuPedido: o.com_doc,
        ganhos: o.ganhos,
        perdidos: o.perdidos,
        temperatura: {
          quente: o.quentes,
          morno: o.mornos,
          frio: o.frios,
          semScore: o.sem_score,
        },
      },
      byOrigin: originRows.map((r) => ({
        origem: r.origem,
        leads: r.leads,
        ganhos: r.ganhos,
        orcamentos: r.orcamentos,
        pedidos: r.pedidos,
        valorGanho: r.valor_ganho,
        conversaoPct: pct(r.pedidos, r.leads),
      })),
      byCampaign: campaignRows.map((r) => ({
        campanha: r.campanha,
        leads: r.leads,
        ganhos: r.ganhos,
        orcamentos: r.orcamentos,
        pedidos: r.pedidos,
        valorGanho: r.valor_ganho,
        conversaoPct: pct(r.pedidos, r.leads),
        gasto: null as number | null,
        cac: null as number | null,
        roas: null as number | null,
      })),
    };
  }

  async getVolumeByChannel(organizationId: string, range: DateRange) {
    const result = await this.prisma.conversation.groupBy({
      by: ['channelId'],
      where: { organizationId, createdAt: { gte: range.from, lte: range.to } },
      _count: true,
    });

    const channels = await this.prisma.channel.findMany({
      where: { organizationId },
      select: { id: true, name: true, type: true },
    });

    return result.map((r) => {
      const ch = channels.find((c) => c.id === r.channelId);
      return { channelId: r.channelId, channelName: ch?.name || 'Unknown', channelType: ch?.type, count: r._count };
    });
  }

  async getVolumeByStatus(organizationId: string) {
    const result = await this.prisma.conversation.groupBy({
      by: ['status'],
      where: { organizationId },
      _count: true,
    });
    return result.map((r) => ({ status: r.status, count: r._count }));
  }

  async getAgentPerformance(organizationId: string, range: DateRange) {
    const [conversations, currentLoadGroups] = await Promise.all([
      this.prisma.conversation.findMany({
        where: {
          organizationId,
          assignedToId: { not: null },
          createdAt: { gte: range.from, lte: range.to },
        },
        select: {
          assignedToId: true,
          status: true,
          firstResponseAt: true,
          closedAt: true,
          createdAt: true,
          assignedTo: { select: { id: true, name: true, avatarUrl: true } },
        },
      }),
      this.prisma.conversation.groupBy({
        by: ['assignedToId'],
        where: {
          organizationId,
          assignedToId: { not: null },
          status: { in: ['OPEN', 'PENDING', 'WAITING'] },
        },
        _count: true,
      }),
    ]);

    const currentLoad = new Map<string, number>();
    for (const g of currentLoadGroups) {
      if (g.assignedToId) currentLoad.set(g.assignedToId, g._count);
    }

    const agentMap = new Map<string, {
      agent: { id: string; name: string; avatarUrl: string | null };
      total: number;
      closed: number;
      responseTimes: number[];
      resolutionTimes: number[];
    }>();

    for (const c of conversations) {
      if (!c.assignedToId || !c.assignedTo) continue;
      if (!agentMap.has(c.assignedToId)) {
        agentMap.set(c.assignedToId, {
          agent: c.assignedTo, total: 0, closed: 0, responseTimes: [], resolutionTimes: [],
        });
      }
      const a = agentMap.get(c.assignedToId)!;
      a.total++;
      if (c.status === 'CLOSED') {
        a.closed++;
        if (c.closedAt) {
          a.resolutionTimes.push((c.closedAt.getTime() - c.createdAt.getTime()) / 60000);
        }
      }
      if (c.firstResponseAt) {
        a.responseTimes.push((c.firstResponseAt.getTime() - c.createdAt.getTime()) / 60000);
      }
    }

    return Array.from(agentMap.values()).map((a) => ({
      agent: a.agent,
      totalConversations: a.total,
      closedConversations: a.closed,
      activeConversations: currentLoad.get(a.agent.id) ?? 0,
      resolutionRate: a.total > 0 ? Math.round((a.closed / a.total) * 100) : 0,
      avgFirstResponseMinutes: a.responseTimes.length
        ? Math.round(a.responseTimes.reduce((s, v) => s + v, 0) / a.responseTimes.length)
        : null,
      avgResolutionMinutes: a.resolutionTimes.length
        ? Math.round(a.resolutionTimes.reduce((s, v) => s + v, 0) / a.resolutionTimes.length)
        : null,
    }));
  }

  async getVolumeFlow(organizationId: string, range: DateRange) {
    const conversations = await this.prisma.conversation.findMany({
      where: {
        organizationId,
        OR: [
          { createdAt: { gte: range.from, lte: range.to } },
          { closedAt: { gte: range.from, lte: range.to } },
        ],
      },
      select: { createdAt: true, closedAt: true },
    });

    const dayKeys = this.eachDay(range.from, range.to);
    const buckets = new Map<string, { created: number; closed: number }>();
    for (const k of dayKeys) buckets.set(k, { created: 0, closed: 0 });

    for (const c of conversations) {
      const ck = c.createdAt.toISOString().slice(0, 10);
      if (buckets.has(ck)) buckets.get(ck)!.created++;
      if (c.closedAt) {
        const dk = c.closedAt.toISOString().slice(0, 10);
        if (buckets.has(dk)) buckets.get(dk)!.closed++;
      }
    }

    return dayKeys.map((d) => ({ date: d, ...buckets.get(d)! }));
  }

  async getPeakHours(organizationId: string, range: DateRange) {
    const conversations = await this.prisma.conversation.findMany({
      where: { organizationId, createdAt: { gte: range.from, lte: range.to } },
      select: { createdAt: true },
    });

    const matrix: number[][] = Array.from({ length: 7 }, () => Array(24).fill(0));
    let max = 0;
    for (const c of conversations) {
      const dow = c.createdAt.getUTCDay();
      const hour = c.createdAt.getUTCHours();
      matrix[dow][hour]++;
      if (matrix[dow][hour] > max) max = matrix[dow][hour];
    }
    return { matrix, max };
  }

  async getMessagesFlow(organizationId: string, range: DateRange) {
    const messages = await this.prisma.message.findMany({
      where: {
        conversation: { organizationId },
        createdAt: { gte: range.from, lte: range.to },
      },
      select: { createdAt: true, direction: true },
    });

    const dayKeys = this.eachDay(range.from, range.to);
    const buckets = new Map<string, { inbound: number; outbound: number }>();
    for (const k of dayKeys) buckets.set(k, { inbound: 0, outbound: 0 });

    for (const m of messages) {
      const k = m.createdAt.toISOString().slice(0, 10);
      const b = buckets.get(k);
      if (!b) continue;
      if (m.direction === 'INBOUND') b.inbound++;
      else b.outbound++;
    }

    return dayKeys.map((d) => ({ date: d, ...buckets.get(d)! }));
  }

  async getBotPerformance(organizationId: string, range: DateRange) {
    const conversations = await this.prisma.conversation.findMany({
      where: { organizationId, createdAt: { gte: range.from, lte: range.to } },
      select: { status: true, assignedToId: true, closedAt: true },
    });

    let botResolved = 0;
    let humanHandled = 0;
    let inFlight = 0;

    for (const c of conversations) {
      if (c.assignedToId) {
        humanHandled++;
      } else if (c.status === 'CLOSED' && c.closedAt) {
        botResolved++;
      } else {
        inFlight++;
      }
    }

    const total = conversations.length;
    const totalCompleted = botResolved + humanHandled;

    return {
      botResolved,
      humanHandled,
      inFlight,
      total,
      botResolutionRate: totalCompleted > 0 ? Math.round((botResolved / totalCompleted) * 100) : null,
      escalationRate: totalCompleted > 0 ? Math.round((humanHandled / totalCompleted) * 100) : null,
    };
  }

  async getTopTags(organizationId: string, range: DateRange, limit = 5) {
    const tagged = await this.prisma.conversationTag.findMany({
      where: {
        conversation: {
          organizationId,
          createdAt: { gte: range.from, lte: range.to },
        },
      },
      select: { tag: { select: { id: true, name: true, color: true } } },
    });

    const counts = new Map<string, { id: string; name: string; color: string; count: number }>();
    for (const t of tagged) {
      const k = t.tag.id;
      if (!counts.has(k)) counts.set(k, { id: t.tag.id, name: t.tag.name, color: t.tag.color, count: 0 });
      counts.get(k)!.count++;
    }

    return Array.from(counts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);
  }

  /**
   * TEMPO DE 1ª RESPOSTA = MEDIANA dos minutos DENTRO DO HORÁRIO COMERCIAL entre
   * a criação da conversa (1ª mensagem do cliente) e a 1ª resposta.
   * - Mediana (não média): robusta a outliers — poucas conversas respondidas no
   *   dia seguinte não inflam mais o número.
   * - Horário comercial: madrugada/fim de semana fechado não conta. Usa
   *   org.aiBusinessHours + org.aiTimezone. Sem config => 24/7.
   */
  private async getAvgFirstResponseTime(organizationId: string, range: DateRange): Promise<number | null> {
    const [convs, org] = await Promise.all([
      this.prisma.conversation.findMany({
        where: {
          organizationId,
          firstResponseAt: { not: null },
          createdAt: { gte: range.from, lte: range.to },
        },
        select: { createdAt: true, firstResponseAt: true },
      }),
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { aiBusinessHours: true, aiTimezone: true },
      }),
    ]);
    if (convs.length === 0) return null;

    const bh = (org?.aiBusinessHours as BusinessHoursConfig | null) ?? null;
    const tz = org?.aiTimezone || 'America/Sao_Paulo';

    const minutes = convs
      .map((c) => this.businessMinutesBetween(c.createdAt, c.firstResponseAt!, bh, tz))
      .filter((m) => Number.isFinite(m))
      .sort((a, b) => a - b);
    if (minutes.length === 0) return null;

    const mid = Math.floor(minutes.length / 2);
    const median =
      minutes.length % 2 === 0 ? (minutes[mid - 1] + minutes[mid]) / 2 : minutes[mid];
    return Math.round(median);
  }

  /** Minutos de expediente entre dois instantes (config no formato aiBusinessHours). */
  private businessMinutesBetween(
    start: Date,
    end: Date,
    config: BusinessHoursConfig | null,
    tz: string,
  ): number {
    const s = start.getTime();
    const e = end.getTime();
    if (e <= s) return 0;
    if (!config) return (e - s) / 60000; // 24/7

    const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    let total = 0;
    let cursor = this.zonedStartOfDay(s, tz);
    for (let i = 0; i < 60 && cursor <= e; i++) {
      const { year, month, day, weekday } = this.zonedParts(cursor, tz);
      const cfg = config[DAYS[weekday]];
      if (cfg && cfg.enabled) {
        const windows =
          cfg.windows && cfg.windows.length > 0 ? cfg.windows : ([['00:00', '24:00']] as Array<[string, string]>);
        for (const [from, to] of windows) {
          const [fh, fm] = from.split(':').map((v) => parseInt(v, 10));
          const [th, tm] = to.split(':').map((v) => parseInt(v, 10));
          const winStart = this.zonedTimeToUtc(year, month, day, fh || 0, fm || 0, tz);
          const winEnd = this.zonedTimeToUtc(year, month, day, th || 0, tm || 0, tz);
          const os = Math.max(s, winStart);
          const oe = Math.min(e, winEnd);
          if (oe > os) total += oe - os;
        }
      }
      cursor = this.zonedStartOfDay(cursor + 26 * 3600000, tz); // avança p/ o próximo dia local
    }
    return total / 60000;
  }

  private zonedParts(utcMs: number, tz: string): { year: number; month: number; day: number; weekday: number } {
    const map: Record<string, string> = {};
    for (const p of tzFmt(tz).formatToParts(new Date(utcMs))) map[p.type] = p.value;
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(map.weekday);
    return { year: +map.year, month: +map.month, day: +map.day, weekday: wd < 0 ? 0 : wd };
  }

  private zonedStartOfDay(utcMs: number, tz: string): number {
    const { year, month, day } = this.zonedParts(utcMs, tz);
    return this.zonedTimeToUtc(year, month, day, 0, 0, tz);
  }

  /** Horário de parede (na tz) -> instante UTC (ms). */
  private zonedTimeToUtc(year: number, month: number, day: number, hour: number, minute: number, tz: string): number {
    const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
    return guess - this.tzOffsetMs(guess, tz);
  }

  private tzOffsetMs(utcMs: number, tz: string): number {
    const map: Record<string, string> = {};
    for (const p of tzFmt(tz).formatToParts(new Date(utcMs))) map[p.type] = p.value;
    let h = +map.hour;
    if (h === 24) h = 0; // quirk do Intl (meia-noite às vezes vem como "24")
    const asUTC = Date.UTC(+map.year, +map.month - 1, +map.day, h, +map.minute, +map.second);
    return asUTC - utcMs;
  }

  private async getAvgResolutionTime(organizationId: string, range: DateRange): Promise<number | null> {
    const convs = await this.prisma.conversation.findMany({
      where: {
        organizationId,
        closedAt: { not: null },
        createdAt: { gte: range.from, lte: range.to },
      },
      select: { createdAt: true, closedAt: true },
    });
    if (convs.length === 0) return null;
    const total = convs.reduce((s, c) => s + (c.closedAt!.getTime() - c.createdAt.getTime()), 0);
    return Math.round(total / convs.length / 60000);
  }

  private async getSlaCompliance(organizationId: string, range: DateRange): Promise<number | null> {
    const dept = await this.prisma.department.findFirst({
      where: { organizationId, isDefault: true },
      select: { slaFirstResponse: true },
    });
    if (!dept?.slaFirstResponse) return null;

    const slaMinutes = dept.slaFirstResponse;
    const convs = await this.prisma.conversation.findMany({
      where: {
        organizationId,
        firstResponseAt: { not: null },
        createdAt: { gte: range.from, lte: range.to },
      },
      select: { createdAt: true, firstResponseAt: true },
    });
    if (convs.length === 0) return null;

    const withinSla = convs.filter(
      (c) => (c.firstResponseAt!.getTime() - c.createdAt.getTime()) / 60000 <= slaMinutes,
    ).length;

    return Math.round((withinSla / convs.length) * 100);
  }

  private calcTrend(current: number, previous: number): number {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 100);
  }
}
