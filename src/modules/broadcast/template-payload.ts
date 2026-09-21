/**
 * Monta o payload de template do WhatsApp Cloud API resolvendo as variáveis por
 * contato. Suporta:
 *  - variáveis NUMERADAS ({{1}}) → parâmetros posicionais;
 *  - variáveis NOMEADAS ({{cliente}}) → parâmetros com `parameter_name`;
 *  - variáveis no CABEÇALHO (header texto) além do corpo.
 *
 * `variablesMapping` (novo formato):
 *   { header?: { <token>: {type,value} }, body?: { <token>: {type,value} } }
 * Compat: se vier um objeto plano { "1": {type,value} }, é tratado como corpo.
 */
export interface VarMapEntry {
  type: 'contactField' | 'static';
  value: string;
}
export type ComponentMap = Record<string, VarMapEntry>;
export interface VariablesMapping {
  header?: ComponentMap;
  body?: ComponentMap;
}

export interface ContactForTemplate {
  name: string | null;
  phone: string | null;
  email: string | null;
}

/** Resolve o valor de uma variável para um contato. Nunca retorna vazio. */
function resolveValue(entry: VarMapEntry, contact: ContactForTemplate): string {
  if (!entry) return ' ';
  if (entry.type === 'static') return entry.value || ' ';
  const name = (contact.name ?? '').trim();
  switch (entry.value) {
    case 'firstName':
      return name.split(/\s+/)[0] || name || 'Cliente';
    case 'name':
      return name || 'Cliente';
    case 'phone':
      return contact.phone ?? ' ';
    case 'email':
      return contact.email ?? ' ';
    default:
      return ' ';
  }
}

const isNamed = (token: string) => !/^\d+$/.test(token);

/** Ordena tokens: numéricos por valor; nomeados em ordem alfabética estável. */
function orderedTokens(map: ComponentMap): string[] {
  const keys = Object.keys(map ?? {});
  const nums = keys.filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b));
  const names = keys.filter((k) => !/^\d+$/.test(k)).sort();
  return [...nums, ...names];
}

/** Monta os `parameters` de um componente (posicional ou nomeado). */
function buildParams(map: ComponentMap, contact: ContactForTemplate): any[] {
  return orderedTokens(map).map((token) => {
    const text = resolveValue(map[token], contact) || ' ';
    return isNamed(token)
      ? { type: 'text', parameter_name: token, text }
      : { type: 'text', text };
  });
}

/** Normaliza o mapping salvo para o formato { header, body }. */
function normalizeMapping(raw: any): VariablesMapping {
  if (!raw || typeof raw !== 'object') return {};
  if (raw.header || raw.body) {
    return { header: raw.header ?? undefined, body: raw.body ?? undefined };
  }
  // Formato legado plano ({ "1": {...} }) = corpo.
  return { body: raw as ComponentMap };
}

/** Payload `template` para POST em /{phoneNumberId}/messages. */
export function buildTemplatePayload(params: {
  to: string;
  templateName: string;
  language: string;
  mapping?: any;
  contact: ContactForTemplate;
}): Record<string, any> {
  const map = normalizeMapping(params.mapping);
  const components: any[] = [];

  if (map.header && Object.keys(map.header).length) {
    const parameters = buildParams(map.header, params.contact);
    if (parameters.length) components.push({ type: 'header', parameters });
  }
  if (map.body && Object.keys(map.body).length) {
    const parameters = buildParams(map.body, params.contact);
    if (parameters.length) components.push({ type: 'body', parameters });
  }

  return {
    messaging_product: 'whatsapp',
    to: params.to,
    type: 'template',
    template: {
      name: params.templateName,
      language: { code: params.language },
      ...(components.length ? { components } : {}),
    },
  };
}
