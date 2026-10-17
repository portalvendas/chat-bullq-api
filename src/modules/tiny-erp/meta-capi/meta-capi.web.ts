/**
 * Decide se um evento CAPI pode ir como `action_source: "website"`.
 *
 * Por quê: conversões personalizadas e a atribuição das campanhas de SITE (LP)
 * só consideram eventos de origem "website". Eventos `system_generated` (CRM)
 * chegam no dataset mas não entram nessas colunas/otimização.
 *
 * Regra (requisitos da Meta para evento web via CAPI): precisa de
 *   - `event_source_url` (URL absoluta da página onde o lead converteu) e
 *   - `client_user_agent` (navegador do lead),
 * e de pelo menos um identificador de navegador/clique (`fbp`, `fbc`/`fbclid`
 * ou IP) — sem isso o casamento seria fraco e não vale marcar como site.
 *
 * Os dados vêm do `metadata.tracking` do contato, gravado pela LP (via n8n):
 * page_url / landing_url / landing_page, user_agent, fbp, fbc, fbclid, ip.
 *
 * Exemplo — entrada:
 *   { page_url: "https://lp.armazemdecora.com.br/cooktop?utm_source=fb",
 *     user_agent: "Mozilla/5.0 …", fbp: "fb.1.1760…", ip: "189.1.2.3" }
 * Saída:
 *   { eventSourceUrl: "https://lp.armazemdecora.com.br/cooktop?utm_source=fb",
 *     userAgent: "Mozilla/5.0 …" }
 */
export interface WebContext {
  eventSourceUrl: string;
  userAgent: string;
}

export function webContextFromTracking(
  tr: Record<string, any> | null | undefined,
  /** URL padrão do site (config) — usada quando a LP não mandou a da página. */
  fallbackUrl?: string | null,
): WebContext | null {
  if (!tr || typeof tr !== 'object') return null;

  const url = firstString(
    tr.page_url,
    tr.landing_url,
    tr.landing_page,
    tr.event_source_url,
    fallbackUrl ?? undefined,
  );
  if (!url || !/^https?:\/\//i.test(url)) return null;

  const userAgent = firstString(tr.client_user_agent, tr.user_agent);
  if (!userAgent) return null;

  const hasBrowserId = !!firstString(
    tr.fbp,
    tr.fbc,
    tr.fbclid,
    tr.ip,
    tr.client_ip_address,
    tr.client_ip,
    tr.ip_address,
  );
  if (!hasBrowserId) return null;

  return { eventSourceUrl: url.slice(0, 1000), userAgent };
}

function firstString(...vals: unknown[]): string | undefined {
  for (const v of vals) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}
