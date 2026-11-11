import { Injectable, Logger } from '@nestjs/common';
import { DashboardService, type DateRange } from './dashboard.service';
import { TinyService } from '../tiny-erp/tiny.service';

/**
 * Dashboard MOBILE — um único endpoint agregado (GET /dashboard/mobile) que
 * entrega o JSON pronto pra renderizar no celular: vendas, propostas, leads,
 * série temporal, ranking de vendedores e métricas de atendimento.
 *
 * Por que agregado: em rede móvel cada round-trip custa caro; o desktop faz
 * ~12 requests, aqui é 1. Os números vêm das MESMAS funções das telas desktop
 * (TinyService.summary / DashboardService.getOverview / getAgentPerformance),
 * então batem com o Dashboard e com "Pedidos & Propostas".
 *
 * Resiliência: cada seção roda em Promise.allSettled — se uma fonte falhar
 * (ex.: Tiny fora), as outras seções seguem e `errors` lista o que caiu.
 * Cache em memória curto (45s) por org+usuário+janela, porque o celular
 * costuma reabrir/puxar pra atualizar com frequência e o overview é pesado.
 * A chave inclui o usuário porque parte dos números respeita o escopo da
 * vendedora logada (LeadScopeService).
 */

const CACHE_TTL_MS = 45_000;
const CACHE_MAX = 300;

/** Variação % (current vs previous). null quando não há base de comparação. */
function deltaPct(current: number, previous: number | null | undefined): number | null {
  if (previous == null) return null;
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface MobileDashboard {
  range: { from: string; to: string };
  generatedAt: string;
  /** Seções que falharam (as demais vêm normalmente). */
  errors: string[];
  vendas: {
    pedidos: number;
    valor: number;
    ticketMedio: number;
    deltaValorPct: number | null;
    deltaPedidosPct: number | null;
  } | null;
  propostas: {
    count: number;
    valor: number;
    /** pedidos ÷ propostas do período (contagem), em %. */
    conversaoPct: number | null;
    deltaCountPct: number | null;
  } | null;
  leads: {
    count: number;
    perDay: number | null;
    noResponse: number;
    deltaPct: number | null;
    /** pedidos ÷ leads do período, em %. */
    conversaoPct: number | null;
  } | null;
  serie: {
    bucket: 'day' | 'week' | 'month';
    points: Array<{ date: string; pedidos: number; vendas: number; propostas: number; propostasValor: number; leads: number }>;
  } | null;
  vendedores: Array<{
    vendedor: string;
    leads: number;
    pedidos: number;
    vendas: number;
    propostas: number;
    propostasValor: number;
    conversaoPct: number | null;
  }> | null;
  atendimento: {
    ativas: number;
    fila: number;
    abertas: number;
    aguardando: number;
    bot: number;
    presas: number;
    primeiraRespostaMin: number | null;
    primeiraRespostaTrend: number;
    slaPct: number | null;
    resolucaoPct: number | null;
    csat: number | null;
    csatRespostas: number;
    conversas: number;
    conversasTrend: number;
    mensagens: number;
  } | null;
  atendentes: Array<{
    id: string;
    nome: string;
    avatarUrl: string | null;
    ativas: number;
    conversas: number;
    fechadas: number;
    resolucaoPct: number;
    primeiraRespostaMin: number | null;
  }> | null;
}

@Injectable()
export class MobileDashboardService {
  private readonly logger = new Logger(MobileDashboardService.name);
  private readonly cache = new Map<string, { at: number; value: MobileDashboard }>();

  constructor(
    private readonly dashboard: DashboardService,
    private readonly tiny: TinyService,
  ) {}

  async getSummary(organizationId: string, userId: string | undefined, range: DateRange): Promise<MobileDashboard> {
    // Arredonda pro minuto: o front recalcula `to = agora` e não queremos
    // perder o cache por causa de milissegundos.
    const minute = (d: Date) => Math.floor(d.getTime() / 60_000);
    const key = `${organizationId}:${userId ?? '-'}:${minute(range.from)}:${minute(range.to)}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;

    const fromIso = range.from.toISOString();
    const toIso = range.to.toISOString();

    const [summaryR, serieR, overviewR, agentsR] = await Promise.allSettled([
      this.tiny.summary(organizationId, fromIso, toIso),
      this.tiny.dailySeries(organizationId, fromIso, toIso),
      this.dashboard.getOverview(organizationId, range),
      this.dashboard.getAgentPerformance(organizationId, range),
    ]);

    const errors: string[] = [];
    const take = <T>(name: string, r: PromiseSettledResult<T>): T | null => {
      if (r.status === 'fulfilled') return r.value;
      errors.push(name);
      const reason = r.reason as any;
      this.logger.warn(`mobile dashboard: seção "${name}" falhou (org=${organizationId}): ${reason?.message ?? reason}`);
      return null;
    };

    const summary = take('comercial', summaryR);
    const serie = take('serie', serieR);
    const overview = take('atendimento', overviewR);
    const agents = take('atendentes', agentsR);

    const value: MobileDashboard = {
      range: { from: fromIso, to: toIso },
      generatedAt: new Date().toISOString(),
      errors,
      vendas: summary
        ? {
            pedidos: summary.pedidos.count,
            valor: round2(summary.pedidos.total),
            ticketMedio: summary.pedidos.count ? round2(summary.pedidos.total / summary.pedidos.count) : 0,
            deltaValorPct: deltaPct(summary.pedidos.total, summary.previous?.pedidos.total),
            deltaPedidosPct: deltaPct(summary.pedidos.count, summary.previous?.pedidos.count),
          }
        : null,
      propostas: summary
        ? {
            count: summary.orcamentos.count,
            valor: round2(summary.orcamentos.total),
            conversaoPct: summary.orcamentos.count
              ? Math.round((summary.pedidos.count / summary.orcamentos.count) * 1000) / 10
              : null,
            deltaCountPct: deltaPct(summary.orcamentos.count, summary.previous?.orcamentos.count),
          }
        : null,
      leads: summary
        ? {
            count: summary.leads.count,
            perDay: summary.leads.perDay,
            noResponse: summary.leads.noResponse,
            deltaPct: deltaPct(summary.leads.count, summary.previous?.leads.count),
            conversaoPct: summary.leads.count
              ? Math.round((summary.pedidos.count / summary.leads.count) * 1000) / 10
              : null,
          }
        : null,
      serie,
      vendedores: summary
        ? summary.porVendedor
            .filter((v) => v.leadsCount || v.pedidosCount || v.propostasCount)
            .map((v) => ({
              vendedor: v.vendedor,
              leads: v.leadsCount,
              pedidos: v.pedidosCount,
              vendas: round2(v.pedidosTotal),
              propostas: v.propostasCount,
              propostasValor: round2(v.propostasTotal),
              conversaoPct: v.leadsCount ? Math.round((v.pedidosCount / v.leadsCount) * 1000) / 10 : null,
            }))
        : null,
      atendimento: overview
        ? {
            ativas: overview.activeConversations,
            fila: overview.activeBreakdown.pending,
            abertas: overview.activeBreakdown.open,
            aguardando: overview.activeBreakdown.waiting,
            bot: overview.activeBreakdown.bot,
            presas: overview.stuckConversations,
            primeiraRespostaMin: overview.avgFirstResponseMinutes,
            primeiraRespostaTrend: overview.avgFirstResponseTrend,
            slaPct: overview.slaCompliancePercent,
            resolucaoPct: overview.resolutionRatePercent,
            csat: overview.csatScore,
            csatRespostas: overview.csatResponses,
            conversas: overview.totalConversations,
            conversasTrend: overview.conversationsTrend,
            mensagens: overview.totalMessages,
          }
        : null,
      atendentes: agents
        ? agents
            .map((a) => ({
              id: a.agent.id,
              nome: a.agent.name,
              avatarUrl: a.agent.avatarUrl,
              ativas: a.activeConversations,
              conversas: a.totalConversations,
              fechadas: a.closedConversations,
              resolucaoPct: a.resolutionRate,
              primeiraRespostaMin: a.avgFirstResponseMinutes,
            }))
            .sort((a, b) => b.conversas - a.conversas || b.ativas - a.ativas)
        : null,
    };

    // Só cacheia resposta completa — se algo falhou, a próxima tentativa refaz.
    if (errors.length === 0) {
      if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value as string);
      this.cache.set(key, { at: Date.now(), value });
    }
    return value;
  }
}
