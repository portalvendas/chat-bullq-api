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

  if (nat.length === 11) return '55' + nat;
  return original;
}
