/**
 * Monta o payload de template do WhatsApp Cloud API resolvendo as variáveis
 * por contato. `variablesMapping` no formato:
 *   { "1": { type: "contactField"|"static", value: "firstName" | "texto" }, ... }
 * As chaves numéricas viram os parâmetros do corpo (body), em ordem.
 */
export interface VarMapEntry {
  type: 'contactField' | 'static';
  value: string;
}
export type VariablesMapping = Record<string, VarMapEntry>;

export interface ContactForTemplate {
  name: string | null;
  phone: string | null;
  email: string | null;
}

/** Resolve o valor de uma variável para um contato. Nunca retorna vazio. */
function resolveValue(entry: VarMapEntry, contact: ContactForTemplate): string {
  if (entry.type === 'static') return entry.value ?? '';
  const name = (contact.name ?? '').trim();
  switch (entry.value) {
    case 'firstName':
      return name.split(/\s+/)[0] || name || 'Cliente';
    case 'name':
      return name || 'Cliente';
    case 'phone':
      return contact.phone ?? '';
    case 'email':
      return contact.email ?? '';
    default:
      return '';
  }
}

/** Payload `template` para POST em /{phoneNumberId}/messages. */
export function buildTemplatePayload(params: {
  to: string;
  templateName: string;
  language: string;
  mapping?: VariablesMapping | null;
  contact: ContactForTemplate;
}): Record<string, any> {
  const mapping = params.mapping ?? {};
  const keys = Object.keys(mapping)
    .filter((k) => /^\d+$/.test(k))
    .sort((a, b) => Number(a) - Number(b));

  const components: any[] = [];
  if (keys.length) {
    components.push({
      type: 'body',
      parameters: keys.map((k) => ({
        type: 'text',
        text: resolveValue(mapping[k], params.contact) || ' ',
      })),
    });
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
