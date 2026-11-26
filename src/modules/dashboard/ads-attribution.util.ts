/**
 * Atribuição de lead/venda a ANÚNCIO (regra de PRIMEIRO TOQUE) — funções puras.
 *
 * Um "toque" é um registro de que o lead veio de mídia paga, extraído do
 * `metadata` de um card ou do contato:
 *   - LP:            utm_source/utm_campaign/utm_medium(conjunto)/utm_content(anúncio)
 *   - Lead Ads:      campaign_name/adset_name/ad_name + campaign_id/adset_id/ad_id
 *   - CTWA (WhatsApp): utm_* preenchidos pela Meta (first-touch) + ad_id (último clique)
 *   - Google/TikTok: gclid/gbraid/wbraid/ttclid ou utm_source
 *
 * Regra de crédito: o PRIMEIRO toque pago do contato que aconteceu ATÉ a data do
 * documento. utm_* são gravados como "first-touch" (nunca sobrescritos), por isso
 * a identificação por nome vem das utm_*; o `ad_id` do CTWA é último clique e só
 * é usado como id quando o toque não tem nome de anúncio.
 */

export interface Touch {
  at: Date;
  platform: string; // 'Meta' | 'Google' | 'TikTok' | <utm_source>
  channel: string; // 'LP' | 'Formulário' | 'WhatsApp' | 'Google' | …
  campaign?: string;
  adset?: string;
  ad?: string;
  campaignId?: string;
  adsetId?: string;
  adId?: string;
}

const s = (v: unknown): string => {
  const t = v == null ? '' : String(v).trim();
  // Macro de plataforma não substituída ({{campaign.name}}, __CAMPAIGN_ID__…) = vazio.
  if (!t || /\{\{.*\}\}|__[A-Z_]+__|\{[a-z_]+\}/.test(t)) return '';
  return t;
};
const isId = (v: string) => /^\d{6,}$/.test(v);
/** utm_medium genérico (cpc, paid…) não é nome de conjunto. */
const GENERIC_MEDIUM = /^(cpc|ppc|paid|pago|paid[_-]?social|social|cpm|ads?|display|banner|email|organic|referral|trafego|tráfego)$/i;

export function normName(v: string | undefined | null): string {
  return String(v ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extrai o toque pago de um metadata (card ou contato). null = sem evidência
 * de mídia paga (orgânico / direto).
 */
export function touchFrom(meta: any, at: Date): Touch | null {
  const m = meta && typeof meta === 'object' ? meta : {};
  const t = m.tracking && typeof m.tracking === 'object' ? m.tracking : {};
  const src = normName(m.source);
  const us = normName(t.utm_source);

  const isLeadAds = src.includes('leadads') || !!t.leadgen_id || !!t.form_id;
  const isCtwa = us === 'facebook_ctwa' || !!t.ctwa_clid;
  const isGoogle = !!(t.gclid || t.gbraid || t.wbraid) || /google|adwords|gads|youtube/.test(us);
  const isTiktok = !!t.ttclid || /tiktok/.test(us);
  const isMeta = isLeadAds || isCtwa || !!t.fbclid || /meta|face|fb|^ig$|insta/.test(us);

  let campaign = s(t.utm_campaign) || s(t.campaign_name) || s(m.campaignName);
  let adset = s(t.utm_medium) || s(t.adset_name);
  if (GENERIC_MEDIUM.test(adset)) adset = '';
  let ad = s(t.utm_content) || s(t.ad_name);

  let campaignId = s(t.campaign_id) || (isMeta ? s(t.utm_id) : '');
  let adsetId = s(t.adset_id);
  let adId = '';
  // Ids podem vir nas próprias UTMs (ex.: utm_campaign={{campaign.id}}).
  if (isId(campaign)) { campaignId = campaignId || campaign; campaign = ''; }
  if (isId(adset)) { adsetId = adsetId || adset; adset = ''; }
  if (isId(ad)) { adId = ad; ad = ''; }
  // ad_id: Lead Ads grava o do formulário (1º toque). CTWA grava o último
  // clique — só serve quando não há nome de anúncio first-touch.
  if (!adId && s(t.ad_id) && (isLeadAds || !ad)) adId = s(t.ad_id);

  let platform = '';
  let channel = '';
  if (isMeta) {
    platform = 'Meta';
    channel = isLeadAds ? 'Formulário' : isCtwa ? 'WhatsApp' : 'LP';
  } else if (isGoogle) {
    platform = channel = 'Google';
  } else if (isTiktok) {
    platform = channel = 'TikTok';
  } else if (us) {
    platform = channel = String(t.utm_source).trim();
  } else if (campaign || campaignId) {
    platform = channel = 'Outros';
  }
  if (!platform) return null;

  // CTWA: o toque só é "conhecido" a partir do clique (ctwa_at) — evita creditar
  // um anúncio clicado DEPOIS de uma venda antiga (contato criado há anos).
  let when = at;
  if (isCtwa && !isLeadAds && t.ctwa_at) {
    const c = new Date(String(t.ctwa_at));
    if (!isNaN(c.getTime()) && c.getTime() > when.getTime()) when = c;
  }

  return {
    at: when,
    platform,
    channel,
    campaign: campaign || undefined,
    adset: adset || undefined,
    ad: ad || undefined,
    campaignId: campaignId || undefined,
    adsetId: adsetId || undefined,
    adId: adId || undefined,
  };
}

/** Primeiro toque (menor `at`) com at <= limite. */
export function firstTouch(touches: Touch[], until?: Date): Touch | null {
  let best: Touch | null = null;
  for (const t of touches) {
    if (until && t.at.getTime() > until.getTime()) continue;
    if (!best || t.at.getTime() < best.at.getTime()) best = t;
  }
  return best;
}

// ── Casamento com a estrutura da Meta ──────────────────────────────────────

export interface MetaAdRef {
  campaignId: string;
  campaignName: string;
  adsetId: string;
  adsetName: string;
  adId: string;
  adName: string;
}

export interface ResolvedNode {
  platform: string;
  campaignKey: string;
  campaignName: string;
  adsetKey: string;
  adsetName: string;
  adKey: string;
  adName: string;
  /** Até onde casou com a Meta (id ou nome): 'anuncio' | 'conjunto' | 'campanha' | null. */
  metaLevel: 'anuncio' | 'conjunto' | 'campanha' | null;
}

export const SEM_CAMPANHA = '(sem campanha)';
export const SEM_CONJUNTO = '(sem conjunto)';
export const SEM_ANUNCIO = '(sem anúncio)';

export class MetaIndex {
  private ads = new Map<string, MetaAdRef>();
  private adsets = new Map<string, { campaignId: string; name: string }>();
  private campaigns = new Map<string, string>();
  private campByName = new Map<string, string>();
  private adsetByName = new Map<string, string>();
  private adByName = new Map<string, string>();
  private adByCampName = new Map<string, string | null>();

  constructor(rows: MetaAdRef[]) {
    for (const r of rows) {
      if (!r.campaignId) continue;
      this.campaigns.set(r.campaignId, r.campaignName);
      if (!this.campByName.has(normName(r.campaignName))) this.campByName.set(normName(r.campaignName), r.campaignId);
      if (r.adsetId) {
        this.adsets.set(r.adsetId, { campaignId: r.campaignId, name: r.adsetName });
        const k = `${r.campaignId}|${normName(r.adsetName)}`;
        if (!this.adsetByName.has(k)) this.adsetByName.set(k, r.adsetId);
      }
      if (r.adId) {
        this.ads.set(r.adId, r);
        const k = `${r.adsetId}|${normName(r.adName)}`;
        if (!this.adByName.has(k)) this.adByName.set(k, r.adId);
        // Mesmo nome de anúncio em 2 conjuntos da campanha = ambíguo (null).
        const kc = `${r.campaignId}|${normName(r.adName)}`;
        const cur = this.adByCampName.get(kc);
        this.adByCampName.set(kc, cur === undefined || cur === r.adId ? r.adId : null);
      }
    }
  }

  campaignName(id: string) { return this.campaigns.get(id); }
  adsetRef(id: string) { return this.adsets.get(id); }
  adRef(id: string) { return this.ads.get(id); }

  resolve(t: Touch): ResolvedNode {
    const isMeta = t.platform === 'Meta';
    const p = t.platform;
    let campaignId: string | undefined;
    let adsetId: string | undefined;
    let adId: string | undefined;
    let metaLevel: ResolvedNode['metaLevel'] = null;

    if (isMeta) {
      const byAd = t.adId ? this.ads.get(t.adId) : undefined;
      if (byAd) {
        ({ campaignId, adsetId, adId } = byAd);
        metaLevel = 'anuncio';
      } else {
        campaignId =
          (t.campaignId && this.campaigns.has(t.campaignId) ? t.campaignId : undefined) ??
          (t.campaign ? this.campByName.get(normName(t.campaign)) : undefined) ??
          t.campaignId;
        if (campaignId && this.campaigns.has(campaignId)) metaLevel = 'campanha';
        adsetId =
          (t.adsetId && this.adsets.has(t.adsetId) ? t.adsetId : undefined) ??
          (campaignId && t.adset ? this.adsetByName.get(`${campaignId}|${normName(t.adset)}`) : undefined) ??
          t.adsetId;
        if (adsetId && this.adsets.has(adsetId)) {
          metaLevel = 'conjunto';
          campaignId = this.adsets.get(adsetId)!.campaignId;
        }
        if (t.ad) {
          adId =
            (adsetId ? this.adByName.get(`${adsetId}|${normName(t.ad)}`) : undefined) ??
            (campaignId ? this.adByCampName.get(`${campaignId}|${normName(t.ad)}`) ?? undefined : undefined);
        }
        adId = adId ?? t.adId;
        if (adId && this.ads.has(adId)) {
          const r = this.ads.get(adId)!;
          ({ campaignId, adsetId } = r);
          metaLevel = 'anuncio';
        }
      }
    }

    // Chaves: id da Meta quando houver (m:), senão nome normalizado (n:).
    const campName = (campaignId && this.campaigns.get(campaignId)) || t.campaign || (campaignId ? `Campanha ${campaignId}` : SEM_CAMPANHA);
    const campaignKey = campaignId ? `m:${campaignId}` : `n:${p}|${normName(t.campaign || SEM_CAMPANHA)}`;
    const adsetName = (adsetId && this.adsets.get(adsetId)?.name) || t.adset || (adsetId ? `Conjunto ${adsetId}` : SEM_CONJUNTO);
    const adsetKey = adsetId ? `m:${adsetId}` : `${campaignKey}>n:${normName(t.adset || SEM_CONJUNTO)}`;
    const adName = (adId && this.ads.get(adId)?.adName) || t.ad || (adId ? `Anúncio ${adId}` : SEM_ANUNCIO);
    const adKey = adId ? `m:${adId}` : `${adsetKey}>n:${normName(t.ad || SEM_ANUNCIO)}`;

    return { platform: p, campaignKey, campaignName: campName, adsetKey, adsetName, adKey, adName, metaLevel };
  }
}

// ── Métricas ───────────────────────────────────────────────────────────────

export interface MetricsAcc {
  gasto: number;
  impressoes: number;
  cliques: number;
  leads: number;
  leadsQualificados: number;
  orcamentos: number;
  orcamentosValor: number;
  vendas: number;
  vendasValor: number;
  /** Receita de vendas ligadas ao cliente SÓ pelo nome (selo de confiança). */
  vendasValorPorNome: number;
}

export const emptyAcc = (): MetricsAcc => ({
  gasto: 0, impressoes: 0, cliques: 0, leads: 0, leadsQualificados: 0,
  orcamentos: 0, orcamentosValor: 0, vendas: 0, vendasValor: 0, vendasValorPorNome: 0,
});

export function addAcc(into: MetricsAcc, b: MetricsAcc): void {
  for (const k of Object.keys(into) as (keyof MetricsAcc)[]) into[k] += b[k];
}

const r2 = (n: number) => Math.round(n * 100) / 100;
const div = (a: number, b: number) => (b > 0 ? r2(a / b) : null);

/** Métricas finais prontas pro frontend (custos null quando não há gasto/base). */
export function finalize(a: MetricsAcc) {
  const g = a.gasto > 0 ? a.gasto : 0;
  return {
    gasto: r2(a.gasto),
    impressoes: a.impressoes,
    cliques: a.cliques,
    ctr: a.impressoes > 0 ? Math.round((a.cliques / a.impressoes) * 10000) / 100 : null,
    leads: a.leads,
    leadsQualificados: a.leadsQualificados,
    orcamentos: a.orcamentos,
    orcamentosValor: r2(a.orcamentosValor),
    vendas: a.vendas,
    vendasValor: r2(a.vendasValor),
    ticketMedio: div(a.vendasValor, a.vendas),
    cpl: g ? div(g, a.leads) : null,
    custoLeadQualificado: g ? div(g, a.leadsQualificados) : null,
    custoOrcamento: g ? div(g, a.orcamentos) : null,
    cac: g ? div(g, a.vendas) : null,
    roas: g ? r2(a.vendasValor / g) : null,
    taxaLeadVendaPct: a.leads > 0 ? Math.round((a.vendas / a.leads) * 1000) / 10 : null,
    receitaPorNomePct: a.vendasValor > 0 ? Math.round((a.vendasValorPorNome / a.vendasValor) * 1000) / 10 : null,
  };
}
export type Metrics = ReturnType<typeof finalize>;
