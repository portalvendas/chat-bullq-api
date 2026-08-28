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
  async getCommercial(
    organizationId: string,
    range: DateRange,
    opts?: { origem?: string },
  ) {
    const { from, to } = range;
    const origemFilter = opts?.origem && opts.origem !== 'all' ? opts.origem : null;

    // Etapa de entrada por funil (menor order) — p/ "avançou no funil".
    const entryRows = await this.prisma.pipelineStage.groupBy({
      by: ['pipelineId'],
      _min: { order: true },
      where: { pipeline: { organizationId } },
    });
    const entryOrder = new Map<string, number>(
      entryRows.map((r) => [r.pipelineId, r._min.order ?? 0]),
    );

    // Cards (leads) do período + canal da conversa (p/ derivar a origem).
    const cards = await this.prisma.card.findMany({
      where: { organizationId, createdAt: { gte: from, lte: to } },
      select: {
        id: true,
        createdAt: true,
        contactId: true,
        status: true,
        value: true,
        metadata: true,
        stage: { select: { order: true, pipelineId: true } },
        conversation: { select: { channel: { select: { type: true } } } },
      },
      take: 8000,
    });

    // Normaliza a ORIGEM: utm_source > source > tipo do canal.
    const normOrigem = (m: any, channelType?: string | null): string => {
      const hay = `${String(m?.source ?? '')} ${String(m?.tracking?.utm_source ?? '')}`.toLowerCase();
      const hasG = !!m?.tracking?.gclid;
      if (/insta/.test(hay)) return 'Instagram';
      if (/face|fb|leadads|meta/.test(hay)) return 'Facebook';
      if (/google|adwords|gclid/.test(hay) || hasG) return 'Google';
      if (/tiktok/.test(hay)) return 'TikTok';
      if (/landing|(^|[^a-z])lp([^a-z]|$)/.test(hay)) return 'Landing Page';
      const src = String(m?.source ?? '').trim().toLowerCase();
      if (src && src !== 'organico' && src !== 'organic') {
        return src.charAt(0).toUpperCase() + src.slice(1);
      }
      // Marketplaces são canais de VENDA legítimos — origem própria.
      const ct = String(channelType ?? '').toUpperCase();
      if (ct.includes('MERCADO')) return 'Mercado Livre';
      if (ct.includes('SHOPEE')) return 'Shopee';
      // WhatsApp/Instagram/Telegram são DESTINO (porta de entrada após o
      // formulário), NÃO origem. Sem UTM identificável => Orgânico / Direto.
      return 'Orgânico / Direto';
    };
    const campOf = (m: any): string => {
      const c = m?.tracking?.utm_campaign || m?.campaignName;
      return c && String(c).trim() ? String(c).trim() : '(sem campanha)';
    };

    type Row = {
      createdAt: Date;
      contactId: string | null;
      status: string;
      value: number;
      origem: string;
      campanha: string;
      ls: number | null;
      avancou: boolean;
    };
    const allRows: Row[] = cards.map((c) => {
      const m = (c.metadata ?? {}) as any;
      const eo = entryOrder.get(c.stage.pipelineId) ?? 0;
      const lsRaw = m?.leadScore;
      const ls = /^\d+$/.test(String(lsRaw)) ? parseInt(String(lsRaw), 10) : null;
      return {
        createdAt: c.createdAt,
        contactId: c.contactId,
        status: String(c.status),
        value: c.value ? Number(c.value) : 0,
        origem: normOrigem(m, c.conversation?.channel?.type),
        campanha: campOf(m),
        ls,
        avancou: c.stage.order > eo,
      };
    });

    // Lista completa de origens (independe do filtro), p/ os chips do frontend.
    const origins = [...new Set(allRows.map((r) => r.origem))].sort();

    const filtered = origemFilter
      ? allRows.filter((r) => r.origem === origemFilter)
      : allRows;

    // FUSÃO DE LEAD: um mesmo contato pode ter o card do WhatsApp (porta de
    // entrada, sem UTM) e o card do formulário (com UTM) — é o MESMO lead.
    // Conta como 1 lead e a ORIGEM IDENTIFICADA (com UTM) vence a "Orgânico".
    const ORGANICO = 'Orgânico / Direto';
    const byContactRep = new Map<string, Row>();
    const noContactRows: Row[] = [];
    for (const r of filtered) {
      if (!r.contactId) {
        noContactRows.push(r);
        continue;
      }
      const cur = byContactRep.get(r.contactId);
      if (!cur) {
        byContactRep.set(r.contactId, r);
        continue;
      }
      const curIdent = cur.origem !== ORGANICO;
      const rIdent = r.origem !== ORGANICO;
      let winner = cur;
      if (rIdent && !curIdent) winner = r;
      else if (rIdent === curIdent) {
        if (r.status === 'WON' && cur.status !== 'WON') winner = r;
        else if (r.status === cur.status && r.value > cur.value) winner = r;
      }
      byContactRep.set(r.contactId, winner);
    }
    const rows = [...byContactRep.values(), ...noContactRows];

    // Orçamentos/Pedidos (Tiny) dos contatos desses leads.
    const contactIds = [...new Set(rows.map((r) => r.contactId).filter(Boolean))] as string[];
    const tinyDocs = contactIds.length
      ? await this.prisma.tinyDocument.findMany({
          where: {
            organizationId,
            contactId: { in: contactIds },
            kind: { in: ['ORCAMENTO', 'PEDIDO'] },
          },
          select: { contactId: true, kind: true, valor: true },
        })
      : [];
    const orcByContact = new Map<string, { count: number; val: number }>();
    const pedByContact = new Map<string, { count: number; val: number }>();
    for (const d of tinyDocs) {
      if (!d.contactId) continue;
      const map = d.kind === 'ORCAMENTO' ? orcByContact : pedByContact;
      const cur = map.get(d.contactId) ?? { count: 0, val: 0 };
      cur.count += 1;
      cur.val += d.valor ? Number(d.valor) : 0;
      map.set(d.contactId, cur);
    }
    const hasOrc = (cid: string | null) => !!(cid && orcByContact.has(cid));
    const hasPed = (cid: string | null) => !!(cid && pedByContact.has(cid));

    const pct = (num: number, den: number) =>
      den > 0 ? Math.round((num / den) * 1000) / 10 : 0;
    const sumMap = (m: Map<string, { count: number; val: number }>, k: 'count' | 'val') =>
      [...m.values()].reduce((s, x) => s + x[k], 0);

    const leads = rows.length;
    const avancaram = rows.filter((r) => r.avancou).length;
    const ganhos = rows.filter((r) => r.status === 'WON').length;
    const perdidos = rows.filter((r) => r.status === 'LOST').length;
    const comDoc = rows.filter((r) => hasOrc(r.contactId) || hasPed(r.contactId)).length;
    const qualificados = rows.filter(
      (r) =>
        r.avancou ||
        r.status === 'WON' ||
        (r.ls != null && r.ls >= 40) ||
        hasOrc(r.contactId) ||
        hasPed(r.contactId),
    ).length;
    const orcamentos = sumMap(orcByContact, 'count');
    const orcamentosValor = sumMap(orcByContact, 'val');
    const pedidos = sumMap(pedByContact, 'count');
    const pedidosValor = sumMap(pedByContact, 'val');
    const valorGanho = rows
      .filter((r) => r.status === 'WON')
      .reduce((s, r) => s + r.value, 0);

    const quentes = rows.filter((r) => r.ls != null && r.ls >= 70).length;
    const mornos = rows.filter((r) => r.ls != null && r.ls >= 40 && r.ls < 70).length;
    const frios = rows.filter((r) => r.ls != null && r.ls < 40).length;
    const semScore = rows.filter((r) => r.ls == null).length;

    const groupBy = (key: 'origem' | 'campanha') => {
      const g = new Map<string, Row[]>();
      for (const r of rows) {
        const k = r[key];
        (g.get(k) ?? g.set(k, []).get(k)!).push(r);
      }
      return [...g.entries()]
        .map(([name, rs]) => ({
          name,
          leads: rs.length,
          ganhos: rs.filter((r) => r.status === 'WON').length,
          orcamentos: rs.filter((r) => hasOrc(r.contactId)).length,
          pedidos: rs.filter((r) => hasPed(r.contactId)).length,
          valorGanho: rs
            .filter((r) => r.status === 'WON')
            .reduce((s, r) => s + r.value, 0),
        }))
        .sort((a, b) => b.leads - a.leads)
        .slice(0, 30);
    };

    // ── Série temporal (evolução) por origem ──────────────────────
    const spanDays = Math.max(1, Math.ceil((to.getTime() - from.getTime()) / 86400000));
    const weekly = spanDays > 45;
    const bucketKey = (d: Date): string => {
      const t = new Date(d.getTime());
      if (weekly) t.setUTCDate(t.getUTCDate() - t.getUTCDay());
      return t.toISOString().slice(0, 10);
    };
    const bucketList: string[] = [];
    {
      const step = weekly ? 7 : 1;
      const start = new Date(from.getTime());
      start.setUTCHours(0, 0, 0, 0);
      if (weekly) start.setUTCDate(start.getUTCDate() - start.getUTCDay());
      for (let t = start.getTime(); t <= to.getTime(); t += step * 86400000) {
        bucketList.push(new Date(t).toISOString().slice(0, 10));
      }
    }
    const leadsByOrigem = new Map<string, number>();
    for (const r of rows) leadsByOrigem.set(r.origem, (leadsByOrigem.get(r.origem) ?? 0) + 1);
    const topOrigins = [...leadsByOrigem.entries()]
      .sort((a2, b2) => b2[1] - a2[1])
      .slice(0, 6)
      .map(([o]) => o);
    const topSet = new Set(topOrigins);
    const labelFor = (o: string) => (topSet.has(o) ? o : 'Outros');
    const seriesOrigins = [...topOrigins];
    if (rows.some((r) => !topSet.has(r.origem))) seriesOrigins.push('Outros');

    const acc = new Map<string, Map<string, { leads: number; orc: number; ped: number }>>();
    for (const bk of bucketList) acc.set(bk, new Map());
    for (const r of rows) {
      const bk = bucketKey(r.createdAt);
      let m = acc.get(bk);
      if (!m) {
        m = new Map();
        acc.set(bk, m);
      }
      const lab = labelFor(r.origem);
      const cur = m.get(lab) ?? { leads: 0, orc: 0, ped: 0 };
      cur.leads += 1;
      if (hasOrc(r.contactId)) cur.orc += 1;
      if (hasPed(r.contactId)) cur.ped += 1;
      m.set(lab, cur);
    }
    const conversionSeries = bucketList.map((bk) => {
      const point: Record<string, number | string | null> = { date: bk };
      const m = acc.get(bk);
      for (const o of seriesOrigins) {
        const v = m?.get(o);
        point[o] = v && v.leads > 0 ? Math.round((v.ped / v.leads) * 1000) / 10 : null;
      }
      return point;
    });
    const orcamentosSeries = bucketList.map((bk) => {
      const point: Record<string, number | string> = { date: bk };
      const m = acc.get(bk);
      for (const o of seriesOrigins) point[o] = m?.get(o)?.orc ?? 0;
      return point;
    });

    return {
      origins,
      appliedOrigem: origemFilter,
      series: {
        origins: seriesOrigins,
        weekly,
        conversion: conversionSeries,
        orcamentos: orcamentosSeries,
      },
      overview: {
        leads,
        qualificados,
        qualificadosPct: pct(qualificados, leads),
        orcamentos,
        orcamentosValor,
        pedidos,
        pedidosValor,
        ganhos,
        perdidos,
        valorGanho,
        ticketMedio: pedidos > 0 ? Math.round((pedidosValor / pedidos) * 100) / 100 : 0,
        gasto: null as number | null,
        cac: null as number | null,
        roas: null as number | null,
      },
      funnel: {
        leads,
        orcamentos,
        pedidos,
        leadParaOrcamentoPct: pct(orcamentos, leads),
        orcamentoParaPedidoPct: pct(pedidos, orcamentos),
        leadParaPedidoPct: pct(pedidos, leads),
      },
      quality: {
        avancaram,
        naoAvancaram: Math.max(leads - avancaram, 0),
        comOrcamentoOuPedido: comDoc,
        ganhos,
        perdidos,
        temperatura: { quente: quentes, morno: mornos, frio: frios, semScore },
      },
      byOrigin: groupBy('origem').map((r) => ({
        origem: r.name,
        leads: r.leads,
        ganhos: r.ganhos,
        orcamentos: r.orcamentos,
        pedidos: r.pedidos,
        valorGanho: r.valorGanho,
        conversaoPct: pct(r.pedidos, r.leads),
      })),
      byCampaign: groupBy('campanha').map((r) => ({
        campanha: r.name,
        leads: r.leads,
        ganhos: r.ganhos,
        orcamentos: r.orcamentos,
        pedidos: r.pedidos,
        valorGanho: r.valorGanho,
        conversaoPct: pct(r.pedidos, r.leads),
        gasto: null as number | null,
        cac: null as number | null,
        roas: null as number | null,
      })),
    };
  }

  /**
   * DIAGNÓSTICO DE CAPTAÇÃO (n8n -> /public/leads -> CRM). Confere, nos leads
   * dos últimos 30 dias, se estão chegando com telefone (fusão com WhatsApp) e
   * com utm_source/utm_campaign (origem). Só leitura; telefone mascarado.
   */
  async getIntakeHealth(organizationId: string) {
    const since = new Date(Date.now() - 30 * 86400000);
    const cards = await this.prisma.card.findMany({
      where: { organizationId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 500,
      select: {
        createdAt: true,
        title: true,
        metadata: true,
        contact: { select: { phone: true, name: true } },
      },
    });
    let comUtmSource = 0;
    let comUtmCampaign = 0;
    let comTelefone = 0;
    const sample: Array<{
      date: string;
      nome: string | null;
      telefone: string | null;
      utmSource: string | null;
      utmCampaign: string | null;
      source: string | null;
    }> = [];
    for (const c of cards) {
      const m = (c.metadata ?? {}) as any;
      const utmS = (m?.tracking?.utm_source as string) || null;
      const utmC = (m?.tracking?.utm_campaign as string) || (m?.campaignName as string) || null;
      const phone = c.contact?.phone || null;
      if (utmS) comUtmSource += 1;
      if (utmC) comUtmCampaign += 1;
      if (phone) comTelefone += 1;
      if (sample.length < 12) {
        sample.push({
          date: c.createdAt.toISOString(),
          nome: c.contact?.name || c.title || null,
          telefone: phone ? phone.replace(/.(?=.{4})/g, '•') : null,
          utmSource: utmS,
          utmCampaign: utmC,
          source: (m?.source as string) || null,
        });
      }
    }
    const total = cards.length;
    const pct = (n: number) => (total > 0 ? Math.round((n / total) * 100) : 0);
    return {
      total,
      janelaDias: 30,
      comTelefone,
      comTelefonePct: pct(comTelefone),
      comUtmSource,
      comUtmSourcePct: pct(comUtmSource),
      comUtmCampaign,
      comUtmCampaignPct: pct(comUtmCampaign),
      sample,
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
