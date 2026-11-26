import { MetaIndex, finalize, emptyAcc, firstTouch, touchFrom } from './ads-attribution.util';

const META = [
  { campaignId: '111', campaignName: '[LP] Cooktops', adsetId: '211', adsetName: 'Aberto 25-55', adId: '311', adName: 'Video 01' },
  { campaignId: '111', campaignName: '[LP] Cooktops', adsetId: '212', adsetName: 'Remarketing', adId: '312', adName: 'Video 01' },
  { campaignId: '122', campaignName: '[FORM] Organizadores', adsetId: '222', adsetName: 'Interesses', adId: '322', adName: 'Carrossel' },
];
const d = (s: string) => new Date(s);

describe('touchFrom', () => {
  it('LP com UTMs de nome → Meta/LP', () => {
    const t = touchFrom({ tracking: { utm_source: 'metaads', utm_campaign: '[LP] Cooktops', utm_medium: 'Aberto 25-55', utm_content: 'Video 01' } }, d('2026-10-01'));
    expect(t).toMatchObject({ platform: 'Meta', channel: 'LP', campaign: '[LP] Cooktops', adset: 'Aberto 25-55', ad: 'Video 01' });
  });
  it('ids nas UTMs viram ids', () => {
    const t = touchFrom({ tracking: { utm_source: 'ig', utm_campaign: '1202111', utm_medium: '1202211', utm_content: '1202311' } }, d('2026-10-01'))!;
    expect([t.campaignId, t.adsetId, t.adId]).toEqual(['1202111', '1202211', '1202311']);
  });
  it('utm_medium genérico não é conjunto; macro não substituída é vazio', () => {
    const t = touchFrom({ tracking: { utm_source: 'tiktok', utm_campaign: '__CAMPAIGN_NAME__', utm_medium: 'cpc' } }, d('2026-10-01'))!;
    expect(t).toMatchObject({ platform: 'TikTok', campaign: undefined, adset: undefined });
  });
  it('Lead Ads usa ids do formulário', () => {
    const t = touchFrom({ source: 'facebook_leadads', tracking: { campaign_name: '[FORM] Organizadores', ad_id: '322', leadgen_id: 'x' } }, d('2026-10-01'))!;
    expect(t).toMatchObject({ platform: 'Meta', channel: 'Formulário', adId: '322' });
  });
  it('CTWA: ad_id (último clique) não substitui o nome first-touch; data = ctwa_at', () => {
    const t = touchFrom({ tracking: { utm_source: 'facebook_ctwa', utm_content: 'Carrossel', ad_id: '999', ctwa_clid: 'A', ctwa_at: '2026-11-01T00:00:00Z' } }, d('2020-01-01'))!;
    expect(t.adId).toBeUndefined();
    expect(t.at.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });
  it('sem evidência paga → null', () => {
    expect(touchFrom({ source: 'whatsapp', tracking: {} }, d('2026-10-01'))).toBeNull();
  });
});

describe('firstTouch', () => {
  it('pega o mais antigo até o limite', () => {
    const a = { at: d('2026-09-01'), platform: 'Meta', channel: 'LP', campaign: 'A' };
    const b = { at: d('2026-10-01'), platform: 'Google', channel: 'Google', campaign: 'B' };
    expect(firstTouch([b, a])?.campaign).toBe('A');
    expect(firstTouch([b, a], d('2026-08-01'))).toBeNull();
  });
});

describe('MetaIndex.resolve', () => {
  const idx = new MetaIndex(META);
  it('casa por nome campanha+conjunto+anúncio', () => {
    const r = idx.resolve({ at: d('2026-10-01'), platform: 'Meta', channel: 'LP', campaign: '[lp] cooktops', adset: 'Remarketing', ad: 'video 01' });
    expect(r).toMatchObject({ campaignKey: 'm:111', adsetKey: 'm:212', adKey: 'm:312', metaLevel: 'anuncio' });
  });
  it('anúncio de nome repetido em 2 conjuntos sem conjunto = para na campanha', () => {
    const r = idx.resolve({ at: d('2026-10-01'), platform: 'Meta', channel: 'LP', campaign: '[LP] Cooktops', ad: 'Video 01' });
    expect(r.campaignKey).toBe('m:111');
    expect(r.metaLevel).toBe('campanha');
  });
  it('por id de anúncio', () => {
    expect(idx.resolve({ at: d('2026-10-01'), platform: 'Meta', channel: 'Formulário', adId: '322' })).toMatchObject({ campaignName: '[FORM] Organizadores', metaLevel: 'anuncio' });
  });
  it('fora da Meta (Google) agrupa por nome', () => {
    const r = idx.resolve({ at: d('2026-10-01'), platform: 'Google', channel: 'Google', campaign: 'PMax Cooktop' });
    expect(r).toMatchObject({ campaignKey: 'n:Google|pmax cooktop', metaLevel: null });
  });
});

describe('finalize', () => {
  it('custos só com gasto; ROAS = receita/gasto', () => {
    const a = { ...emptyAcc(), gasto: 1000, leads: 50, vendas: 4, vendasValor: 8000, vendasValorPorNome: 2000 };
    expect(finalize(a)).toMatchObject({ cpl: 20, cac: 250, roas: 8, receitaPorNomePct: 25 });
    expect(finalize({ ...a, gasto: 0 }).cac).toBeNull();
  });
});
