/**
 * Utilitário de telefone ciente do padrão brasileiro (DDI 55 + "nono dígito").
 *
 * PROBLEMA QUE RESOLVE
 * --------------------
 * O WhatsApp/Z-API frequentemente entrega o número do celular SEM o 9º dígito
 * (ex.: `55 62 9676-2444` → `556296762444`), enquanto formulários (Landing
 * Page, Lead Ads, import de planilha) capturam o número COMPLETO, COM o 9
 * (ex.: `55 62 99676-2444` → `5562996762444`). Como o match de contato era
 * feito por igualdade EXATA de string, a mesma pessoa virava DOIS contatos e
 * DOIS cards.
 *
 * Estas funções geram/normalizam todas as formas equivalentes para que o
 * `where: { phone: { in: phoneVariants(x) } }` unifique os dois — em qualquer
 * ordem de chegada.
 */

/** Remove tudo que não é dígito. */
export function phoneDigits(v: unknown): string {
  return String(v ?? '').replace(/\D/g, '');
}

/**
 * Gera todas as formas equivalentes de um telefone, cobrindo:
 *  - presença/ausência do DDI 55;
 *  - presença/ausência do 9º dígito em celulares BR.
 *
 * Ex.: qualquer uma de "(62) 99676-2444", "62996762444", "5562996762444" ou
 * "556296762444" produz um conjunto que contém TODAS elas.
 */
export function phoneVariants(raw: unknown): string[] {
  const original = phoneDigits(raw);
  if (!original) return [];

  // Trabalha no número NACIONAL (sem DDI) para raciocinar sobre DDD + assinante.
  let nat = original;
  if (nat.length > 11 && nat.startsWith('55')) nat = nat.slice(2);

  const out = new Set<string>();
  const add = (n: string) => {
    if (!n) return;
    out.add(n); // sem DDI
    out.add('55' + n); // com DDI
  };

  // Sempre inclui a forma como veio (com e sem DDI).
  out.add(original);
  add(nat);

  // Deriva a contraparte do 9º dígito quando parece nacional (DDD + assinante).
  if (nat.length === 11 || nat.length === 10) {
    const ddd = nat.slice(0, 2);
    const sub = nat.slice(2);
    if (sub.length === 9 && sub[0] === '9') {
      // Tem o 9 → adiciona a versão SEM o 9.
      add(ddd + sub.slice(1));
    } else if (sub.length === 8 && /^[6-9]/.test(sub)) {
      // Não tem o 9 e é faixa de celular (6-9) → adiciona a versão COM o 9.
      add(ddd + '9' + sub);
    }
  }

  return [...out];
}

/**
 * Forma canônica preferida para GRAVAR/COMPARAR um celular BR:
 * DDI 55 + DDD + 9 dígitos. Se não parecer um número nacional BR, devolve
 * apenas os dígitos originais (não força nada).
 */
export function canonicalPhone(raw: unknown): string | null {
  const original = phoneDigits(raw);
  if (!original) return null;

  let nat = original;
  if (nat.length > 11 && nat.startsWith('55')) nat = nat.slice(2);

  if (nat.length === 10) {
    const ddd = nat.slice(0, 2);
    const sub = nat.slice(2);
    if (/^[6-9]/.test(sub)) nat = ddd + '9' + sub; // celular sem 9 → com 9
  }

  // Só é celular BR se: DDD válido (sem 0) + 9 na 3ª posição. Sem essa trava,
  // um número estrangeiro de 11 dígitos (ex.: EUA 1 415 555 0123) ganhava um
  // "55" falso na frente.
  if (nat.length === 11 && /^[1-9]{2}9/.test(nat)) return '55' + nat;
  return original;
}

/**
 * Canonicaliza o campo `phone` de um `data` de escrita do Prisma (Contact).
 * Aceita as duas formas que o Prisma permite: valor direto ou `{ set: valor }`.
 * Não mexe quando `phone` está ausente (undefined) — só normaliza o que veio.
 *
 *   { phone: '(73) 8868-8598' }      → { phone: '5573988688598' }
 *   { phone: { set: '557388688598' } } → { phone: { set: '5573988688598' } }
 *   { phone: '' }                    → { phone: null }
 */
export function canonicalizePhoneField<T extends Record<string, any>>(data: T): T {
  if (!data || typeof data !== 'object' || !('phone' in data)) return data;
  const v = (data as any).phone;
  if (v === undefined || v === null) return data;
  if (typeof v === 'object' && 'set' in v) {
    const set = v.set == null ? v.set : canonicalPhone(v.set);
    return { ...data, phone: { set } };
  }
  return { ...data, phone: canonicalPhone(v) };
}

/** DDDs válidos no Brasil (Anatel). Usado para barrar telefone inventado. */
const BR_DDDS = new Set([
  11, 12, 13, 14, 15, 16, 17, 18, 19, 21, 22, 24, 27, 28, 31, 32, 33, 34, 35, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48, 49, 51, 53, 54, 55, 61, 62, 63, 64, 65, 66, 67, 68,
  69, 71, 73, 74, 75, 77, 79, 81, 82, 83, 84, 85, 86, 87, 88, 89, 91, 92, 93, 94, 95,
  96, 97, 98, 99,
]);

/**
 * Classifica um telefone JÁ canônico (ver canonicalPhone) como número BR que
 * pode ter WhatsApp:
 *  - 'mobile'   = 55 + DDD + 9 + 8 dígitos;
 *  - 'landline' = 55 + DDD + 8 dígitos começando de 2 a 5 (fixo — empresas
 *    usam WhatsApp Business em fixo).
 * DDD precisa existir. Retorna null se for inválido/incompleto.
 *
 *   '5562996762444' → 'mobile'   · '551933772900' → 'landline'
 *   '552012345678'  → null (DDD 20 não existe)
 */
export function brWhatsappPhoneKind(phone: unknown): 'mobile' | 'landline' | null {
  const d = phoneDigits(phone);
  const m = /^55(\d{2})(\d{8,9})$/.exec(d);
  if (!m || !BR_DDDS.has(Number(m[1]))) return null;
  const sub = m[2];
  if (sub.length === 9 && sub[0] === '9') return 'mobile';
  if (sub.length === 8 && /^[2-5]/.test(sub)) return 'landline';
  return null;
}

/**
 * Telefone BR pronto para WhatsApp (55 + DDD + número), celular OU fixo, com
 * DDD válido. Completa o DDI de número nacional (10/11 dígitos) — inclusive
 * fixo e DDD 55. Retorna null se for inválido/incompleto.
 *
 *   '(19) 3377-2900' → '551933772900' · '(62) 9676-2444' → '5562996762444'
 *   '552012345678'   → null
 */
export function brWhatsappPhone(raw: unknown): string | null {
  let c = canonicalPhone(raw);
  if (!c) return null;
  if (c.length === 10 || c.length === 11) c = '55' + c; // nacional sem DDI
  return brWhatsappPhoneKind(c) ? c : null;
}
