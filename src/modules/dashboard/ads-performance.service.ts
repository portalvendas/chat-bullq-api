import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { MetaAdsService } from './meta-ads.service';
import {
  MetaIndex,
  addAcc,
  emptyAcc,
  finalize,
  firstTouch,
  touchFrom,
  type Metrics,
  type MetricsAcc,
  type ResolvedNode,
  type Touch,
} from './ads-attribution.util';

export interface DateRange {
  from: Date;
  to: Date;
}

/** Vínculo pedido/orçamento → cliente feito SÓ pelo nome (selo de confiança). */
const WEAK_MATCHES = new Set(['name', 'name_partial']);
/** Mesmo filtro de "venda efetiva" do Comercial/TinyService. */
const PEDIDO_EXCLUIDOS = new Set(['Cancelada', 'Dados Incompletos', 'Removido']);
/** Score a partir do qual o lead é "qualificado" (mesmo corte do CAPI QualifiedLead). */
const QUALIFIED_SCORE = 60;
/** `data` do Tiny é só o dia: o toque vale até o fim desse dia (+ folga de fuso). */
const DOC_DAY_SLACK_MS = 36 * 3600 * 1000;
const CHUNK = 5000;

type NonAdBucket = 'semAnuncio' | 'clienteAntesDoAnuncio' | 'semCliente';
const NON_AD_LABEL: Record<NonAdBucket, string> = {
  semAnuncio: 'Cliente sem anúncio (orgânico / direto)',
  clienteAntesDoAnuncio: 'Cliente já existia antes do 1º anúncio',
  semCliente: 'Documento sem cliente ligado',
};

interface Node {
  key: string;
  name: string;
  acc: MetricsAcc;
}
interface AdsetNode extends Node { ads: Map<string, Node> }
interface CampaignNode extends Node { platform: string; metaLevel: ResolvedNode['metaLevel']; adsets: Map<string, AdsetNode> }

/** Linha por documento (export .xlsx). */
export interface AttributedDoc {
  tipo: 'Pedido' | 'Orçamento';
  numero: string | null;
  data: Date | null;
  valor: number;
  situacao: string | null;
  cliente: string | null;
  matchedBy: string | null;
  porNome: boolean;
  primeiroToqueEm: Date | null;
  plataforma: string;
  canal: string;
  campanha: string;
  conjunto: string;
  anuncio: string;
  casouComMeta: string;
}

/**
 * Desempenho de mídia paga POR ANÚNCIO (campanha › conjunto › anúncio),
 * cruzando gasto da Meta com leads, orçamentos e vendas do Tiny.
 *
 * Regra de crédito: PRIMEIRO TOQUE pago do cliente até a data do documento.
 * Leads: contatos cujo 1º toque pago aconteceu no período (lead NOVO daquele anúncio).
 * Documentos: orçamentos/pedidos com data no período (mesma base do Comercial).
 * Agregação 100% server-side: o frontend só renderiza a árvore.
 *
 * Exemplo de saída (resumida):
 * { attribution: "first_touch", metaConfigured: true,
 *   totals: { gasto: 9120.4, leads: 412, vendas: 61, vendasValor: 80210, roas: 8.79, … },
 *   coverage: { vendas: { total: {n:235,valor:319111}, comAnuncio: {…}, … } },
 *   campaigns: [ { key: "m:1202…", name: "[LP] Cooktops", platform: "Meta",
 *                  metrics: {…}, adsets: [ { key, name, metrics, ads: [ {key,name,metrics} ] } ] } ],
 *   nonAd: [ { key: "semAnuncio", label: "Cliente sem anúncio…", metrics: {…} } ] }
 */
@Injectable()
export class AdsPerformanceService {
  private readonly logger = new Logger(AdsPerformanceService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly metaAds: MetaAdsService,
  ) {}

  async getReport(organizationId: string, range: DateRange) {
    return (await this.compute(organizationId, range)).report;
  }

  /** Relatório + atribuição por documento (usado também pelo export). */
  async compute(organizationId: string, range: DateRange) {
    const { from, to } = range;

    // 1) Gasto por anúncio na Meta (best-effort — sem integração o relatório segue só com CRM).
    let insights: Awaited<ReturnType<MetaAdsService['getAdInsights']>> = null;
    try {
      insights = await this.metaAds.getAdInsights(organizationId, range);
    } catch (err: any) {
      this.logger.warn(`getAdInsights falhou (org ${organizationId}): ${err?.message ?? err}`);
    }
    const index = new MetaIndex(insights ?? []);

    // 2) Documentos do período (mesma base do Comercial).
    const docsRaw = await this.prisma.tinyDocument.findMany({
      where: { organizationId, kind: { in: ['ORCAMENTO', 'PEDIDO'] }, data: { gte: from, lte: to } },
      select: {
        kind: true, numero: true, data: true, valor: true, situacao: true, natureza: true,
        isMarketplace: true, clienteNome: true, contactId: true, matchedBy: true, matchManual: true,
      },
      orderBy: { data: 'asc' },
    });
    const docs = docsRaw.filter(
      (d) =>
        d.kind === 'ORCAMENTO' ||
        (!PEDIDO_EXCLUIDOS.has(String(d.situacao ?? '')) &&
          d.isMarketplace !== true &&
          /venda/i.test(String(d.natureza ?? ''))),
    );

    // 3) Contatos relevantes: com card/contato criado no período OU com documento.
    const periodCards = await this.prisma.$queryRaw<Array<{ contact_id: string }>>`
      SELECT DISTINCT contact_id FROM cards
      WHERE organization_id = ${organizationId} AND contact_id IS NOT NULL
        AND created_at >= ${from} AND created_at <= ${to}`;
    const periodContacts = await this.prisma.contact.findMany({
      where: { organizationId, deletedAt: null, createdAt: { gte: from, lte: to } },
      select: { id: true },
    });
    const ids = [
      ...new Set([
        ...periodCards.map((r) => r.contact_id),
        ...periodContacts.map((c) => c.id),
        ...(docs.map((d) => d.contactId).filter(Boolean) as string[]),
      ]),
    ];

    // 4) Toques de cada contato (todos os cards + o próprio contato) e maior leadScore.
    const touches = new Map<string, Touch[]>();
    const maxScore = new Map<string, number>();
    const push = (cid: string, t: Touch | null) => {
      if (!t) return;
      const arr = touches.get(cid);
      if (arr) arr.push(t);
      else touches.set(cid, [t]);
    };
    for (let i = 0; i < ids.length; i += CHUNK) {
      const part = ids.slice(i, i + CHUNK);
      const cards = await this.prisma.$queryRaw<
        Array<{ contact_id: string; created_at: Date; tracking: unknown; source: string | null; campaign_name: string | null; lead_score: string | null }>
      >`
        SELECT contact_id, created_at, metadata->'tracking' AS tracking,
               metadata->>'source' AS source, metadata->>'campaignName' AS campaign_name,
               metadata->>'leadScore' AS lead_score
        FROM cards
        WHERE organization_id = ${organizationId} AND contact_id = ANY(${part})`;
      for (const c of cards) {
        push(c.contact_id, touchFrom({ tracking: c.tracking, source: c.source, campaignName: c.campaign_name }, c.created_at));
        const ls = /^\d+$/.test(String(c.lead_score ?? '')) ? parseInt(String(c.lead_score), 10) : NaN;
        if (!isNaN(ls) && ls > (maxScore.get(c.contact_id) ?? -1)) maxScore.set(c.contact_id, ls);
      }
      const contacts = await this.prisma.$queryRaw<
        Array<{ id: string; created_at: Date; tracking: unknown; source: string | null; campaign_name: string | null }>
      >`
        SELECT id, created_at, metadata->'tracking' AS tracking,
               metadata->>'source' AS source, metadata->>'campaignName' AS campaign_name
        FROM contacts
        WHERE organization_id = ${organizationId} AND id = ANY(${part})`;
      for (const c of contacts) {
        push(c.id, touchFrom({ tracking: c.tracking, source: c.source, campaignName: c.campaign_name }, c.created_at));
      }
    }

    // 5) Árvore campanha › conjunto › anúncio.
    const campaigns = new Map<string, CampaignNode>();
    const nodeFor = (r: ResolvedNode) => {
      let c = campaigns.get(r.campaignKey);
      if (!c) {
        c = { key: r.campaignKey, name: r.campaignName, platform: r.platform, metaLevel: r.metaLevel, acc: emptyAcc(), adsets: new Map() };
        campaigns.set(r.campaignKey, c);
      }
      let s = c.adsets.get(r.adsetKey);
      if (!s) {
        s = { key: r.adsetKey, name: r.adsetName, acc: emptyAcc(), ads: new Map() };
        c.adsets.set(r.adsetKey, s);
      }
      let a = s.ads.get(r.adKey);
      if (!a) {
        a = { key: r.adKey, name: r.adName, acc: emptyAcc() };
        s.ads.set(r.adKey, a);
      }
      return a;
    };

    // Gasto da Meta entra direto no anúncio (aparece mesmo sem lead no CRM).
    for (const row of insights ?? []) {
      if (!row.adId) continue;
      const leaf = nodeFor(
        index.resolve({ at: from, platform: 'Meta', channel: 'Meta', adId: row.adId }),
      );
      leaf.acc.gasto += row.spend;
      leaf.acc.impressoes += row.impressions;
      leaf.acc.cliques += row.clicks;
    }

    const nonAd: Record<NonAdBucket, MetricsAcc> = {
      semAnuncio: emptyAcc(),
      clienteAntesDoAnuncio: emptyAcc(),
      semCliente: emptyAcc(),
    };

    // Leads NOVOS por anúncio: 1º toque pago do contato dentro do período.
    const docContacts = new Set(docs.map((d) => d.contactId).filter(Boolean) as string[]);
    const leadContacts = new Set([...periodCards.map((r) => r.contact_id), ...periodContacts.map((c) => c.id)]);
    for (const cid of leadContacts) {
      const ft = firstTouch(touches.get(cid) ?? []);
      const qualified = (maxScore.get(cid) ?? -1) >= QUALIFIED_SCORE || docContacts.has(cid);
      let acc: MetricsAcc;
      if (!ft) acc = nonAd.semAnuncio;
      else if (ft.at.getTime() < from.getTime() || ft.at.getTime() > to.getTime()) continue; // lead antigo
      else acc = nodeFor(index.resolve(ft)).acc;
      acc.leads += 1;
      if (qualified) acc.leadsQualificados += 1;
    }

    // Documentos: crédito ao 1º toque pago ATÉ a data do documento.
    const coverage = {
      vendas: { total: { n: 0, valor: 0 }, comAnuncio: { n: 0, valor: 0 }, casadoComMeta: { n: 0, valor: 0 }, porNome: { n: 0, valor: 0 }, semAnuncio: { n: 0, valor: 0 }, clienteAntesDoAnuncio: { n: 0, valor: 0 }, semCliente: { n: 0, valor: 0 } },
      orcamentos: { total: { n: 0, valor: 0 }, comAnuncio: { n: 0, valor: 0 }, casadoComMeta: { n: 0, valor: 0 }, porNome: { n: 0, valor: 0 }, semAnuncio: { n: 0, valor: 0 }, clienteAntesDoAnuncio: { n: 0, valor: 0 }, semCliente: { n: 0, valor: 0 } },
    };
    const bump = (b: { n: number; valor: number }, v: number) => { b.n += 1; b.valor += v; };
    const attributedDocs: AttributedDoc[] = [];

    for (const d of docs) {
      const valor = d.valor ? Number(d.valor) : 0;
      const isPed = d.kind === 'PEDIDO';
      const cov = isPed ? coverage.vendas : coverage.orcamentos;
      const porNome = !d.matchManual && WEAK_MATCHES.has(String(d.matchedBy ?? ''));
      bump(cov.total, valor);

      let acc: MetricsAcc;
      let ft: Touch | null = null;
      let res: ResolvedNode | null = null;
      let bucket: NonAdBucket | null = null;
      if (!d.contactId) {
        bucket = 'semCliente';
        acc = nonAd.semCliente;
        bump(cov.semCliente, valor);
      } else {
        const all = touches.get(d.contactId) ?? [];
        const until = d.data ? new Date(d.data.getTime() + DOC_DAY_SLACK_MS) : undefined;
        ft = firstTouch(all, until);
        if (ft) {
          res = index.resolve(ft);
          acc = nodeFor(res).acc;
          bump(cov.comAnuncio, valor);
          if (res.metaLevel) bump(cov.casadoComMeta, valor);
          if (porNome) bump(cov.porNome, valor);
        } else if (all.length) {
          bucket = 'clienteAntesDoAnuncio';
          acc = nonAd.clienteAntesDoAnuncio;
          bump(cov.clienteAntesDoAnuncio, valor);
        } else {
          bucket = 'semAnuncio';
          acc = nonAd.semAnuncio;
          bump(cov.semAnuncio, valor);
        }
      }
      if (isPed) {
        acc.vendas += 1;
        acc.vendasValor += valor;
        if (porNome) acc.vendasValorPorNome += valor;
      } else {
        acc.orcamentos += 1;
        acc.orcamentosValor += valor;
      }

      attributedDocs.push({
        tipo: isPed ? 'Pedido' : 'Orçamento',
        numero: d.numero,
        data: d.data,
        valor,
        situacao: d.situacao,
        cliente: d.clienteNome,
        matchedBy: d.matchManual ? 'manual' : d.matchedBy,
        porNome,
        primeiroToqueEm: ft?.at ?? null,
        plataforma: res?.platform ?? '',
        canal: ft?.channel ?? '',
        campanha: res?.campaignName ?? (bucket ? NON_AD_LABEL[bucket] : ''),
        conjunto: res?.adsetName ?? '',
        anuncio: res?.adName ?? '',
        casouComMeta: res?.metaLevel ?? '',
      });
    }

    // 6) Rollup + serialização (ordenado por gasto, depois receita).
    const totalAcc = emptyAcc();
    const byRank = <T extends { metrics: Metrics }>(a: T, b: T) =>
      b.metrics.gasto - a.metrics.gasto || b.metrics.vendasValor - a.metrics.vendasValor || b.metrics.leads - a.metrics.leads;
    const campaignsOut = [...campaigns.values()]
      .map((c) => {
        const adsets = [...c.adsets.values()]
          .map((s) => {
            const ads = [...s.ads.values()].map((a) => {
              addAcc(s.acc, a.acc);
              return { key: a.key, name: a.name, metrics: finalize(a.acc) };
            });
            addAcc(c.acc, s.acc);
            return { key: s.key, name: s.name, metrics: finalize(s.acc), ads: ads.sort(byRank) };
          })
          .sort(byRank);
        addAcc(totalAcc, c.acc);
        return {
          key: c.key,
          name: c.name,
          platform: c.platform,
          casouComMeta: c.key.startsWith('m:'),
          metrics: finalize(c.acc),
          adsets,
        };
      })
      .sort(byRank);

    const nonAdOut = (Object.keys(nonAd) as NonAdBucket[])
      .map((k) => ({ key: k, label: NON_AD_LABEL[k], metrics: finalize(nonAd[k]) }))
      .filter((x) => x.metrics.leads || x.metrics.orcamentos || x.metrics.vendas);

    const r2 = (n: number) => Math.round(n * 100) / 100;
    const roundCov = (o: Record<string, { n: number; valor: number }>) =>
      Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { n: v.n, valor: r2(v.valor) }]));

    return {
      report: {
        attribution: 'first_touch' as const,
        range: { from: from.toISOString(), to: to.toISOString() },
        metaConfigured: insights != null,
        totals: finalize(totalAcc),
        coverage: { vendas: roundCov(coverage.vendas), orcamentos: roundCov(coverage.orcamentos) },
        platforms: [...new Set(campaignsOut.map((c) => c.platform))].sort(),
        campaigns: campaignsOut,
        nonAd: nonAdOut,
      },
      docs: attributedDocs,
    };
  }
}
