/**
 * Canal de ORIGEM do lead, pela ordem de evidência:
 * marketplace → TikTok → Google (gclid/utm) → IA (ChatGPT etc.) → formulário
 * do Facebook → anúncio Meta que abre o WhatsApp (ctwa) → Instagram →
 * Facebook → Meta Ads (sem FB/IG) → direct do Instagram → LP sem origem →
 * WhatsApp direto → outros.
 *   leadChannel('LP_nova', { utm_source: 'ig' }, 'WHATSAPP_OFFICIAL') → 'Instagram'
 */
export function leadChannel(src: string | null, tr: Record<string, any>, chan: string | null): string {
  const s = String(src ?? '').toLowerCase();
  const utm = String(tr.utm_source ?? '').toLowerCase().trim();
  const c = String(chan ?? '').toUpperCase();
  if (s === 'marketplace-sync' || c === 'MERCADO_LIVRE' || c === 'SHOPEE') return 'Marketplace';
  if (utm.includes('tiktok') || tr.ttclid) return 'TikTok';
  if (tr.gclid || tr.gbraid || tr.wbraid || tr.gad_source || /google|gads|adwords|youtube/.test(utm)) return 'Google';
  if (/chatgpt|openai|perplexity|gemini|copilot|claude/.test(utm)) return 'ChatGPT / IA';
  if (s === 'facebook_leadads' || tr.leadgenId) return 'Facebook (formulário)';
  if (tr.ctwa_clid) return 'Anúncio Meta → WhatsApp';
  if (utm === 'ig' || utm.includes('insta')) return 'Instagram';
  if (utm === 'fb' || utm.includes('face')) return 'Facebook';
  if (utm.includes('meta') || tr.fbclid) return 'Meta Ads';
  if (c === 'INSTAGRAM') return 'Instagram (direct)';
  if (utm) return 'Outros';
  if (s.startsWith('lp') || s.includes('landing')) return 'Landing page (sem origem)';
  if (c.startsWith('WHATSAPP')) return 'WhatsApp direto';
  return 'Outros / manual';
}
