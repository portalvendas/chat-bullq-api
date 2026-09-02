import * as crypto from 'crypto';

/**
 * Normalização + hashing SHA-256 dos dados do cliente conforme a spec da Meta
 * Conversions API (https://developers.facebook.com/docs/marketing-api/conversions-api/parameters/customer-information-parameters).
 *
 * Regra geral: trim + lowercase, remover formatação, então SHA-256 (hex).
 * `fbc`/`fbp` NÃO são hasheados (vão crus). Campos vazios viram `undefined`.
 */

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function clean(v?: string | null): string {
  return (v ?? '').trim().toLowerCase();
}

/** Remove acentos/diacríticos (ã→a, é→e, ç→c) preservando a letra base. */
function deburr(v: string): string {
  return v.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** E-mail: trim + lowercase. */
export function hashEmail(email?: string | null): string | undefined {
  const e = clean(email);
  return e && e.includes('@') ? sha256(e) : undefined;
}

/**
 * Telefone → E.164 (Brasil) antes do SHA-256: `55` + DDD + número, só dígitos.
 * A Meta exige o formato internacional; sem isso o match quality despenca.
 * Regras:
 *   - só dígitos (remove ( ) - espaço + e zeros de tronco à esquerda);
 *   - já com DDI 55 e 12–13 dígitos (fixo/celular) → mantém;
 *   - 10 ou 11 dígitos (DDD + número, sem DDI) → prefixa 55;
 *   - resultado fora de 12–13 dígitos é inválido → undefined (não envia `ph`).
 * O strip de zero à esquerda vem ANTES das checagens, o que também resolve o
 * "0" de operadora e o prefixo internacional "00". Ex.: (45) 99999-9999 →
 * 5545999999999; 045 3333-4444 → 554533334444.
 */
export function hashPhone(phone?: string | null): string | undefined {
  let d = (phone ?? '').replace(/\D/g, '').replace(/^0+/, '');
  if (!d) return undefined;
  const hasDdi55 = d.startsWith('55') && (d.length === 12 || d.length === 13);
  if (!hasDdi55 && (d.length === 10 || d.length === 11)) {
    // DDD + número (fixo 10 / celular 11) sem DDI. Cobre também o DDD 55
    // (Santa Maria/RS): aqui o `55` inicial é DDD, então prefixamos o DDI.
    d = '55' + d;
  }
  // E.164 BR válido tem 12 (fixo) ou 13 (celular) dígitos com o DDI.
  if (d.length < 12 || d.length > 13) return undefined;
  return sha256(d);
}

/** Nome/sobrenome/cidade: lowercase, sem espaços nas pontas. */
export function hashName(v?: string | null): string | undefined {
  const s = deburr(clean(v));
  return s ? sha256(s) : undefined;
}

/** Cidade: lowercase, sem espaços/pontuação. */
export function hashCity(v?: string | null): string | undefined {
  const s = deburr(clean(v)).replace(/[^a-z0-9]/g, '');
  return s ? sha256(s) : undefined;
}

/** UF/estado: 2 letras minúsculas. */
export function hashState(v?: string | null): string | undefined {
  const s = clean(v).replace(/[^a-z]/g, '');
  return s ? sha256(s) : undefined;
}

/** CEP/zip: só dígitos. */
export function hashZip(v?: string | null): string | undefined {
  const s = (v ?? '').replace(/\D/g, '');
  return s ? sha256(s) : undefined;
}

/** País: código ISO 2 letras minúsculas (default br). */
export function hashCountry(v?: string | null): string | undefined {
  let s = clean(v).replace(/[^a-z]/g, '');
  if (!s) s = 'br';
  if (s === 'brasil' || s === 'brazil') s = 'br';
  return sha256(s.slice(0, 2));
}

/** external_id (CPF/CNPJ): só dígitos, hasheado. */
export function hashExternalId(v?: string | null): string | undefined {
  const s = (v ?? '').replace(/\D/g, '');
  return s ? sha256(s) : undefined;
}

/** Divide "Nome Sobrenome" em first/last. */
export function splitName(full?: string | null): { first?: string; last?: string } {
  const parts = (full ?? '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return {};
  if (parts.length === 1) return { first: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

/**
 * Constrói o `fbc` a partir do `fbclid` quando não temos o cookie `_fbc`.
 * Formato: `fb.1.{creation_time_ms}.{fbclid}`. Usa o timestamp do documento.
 */
export function fbcFromFbclid(fbclid?: string | null, tsMs = Date.now()): string | undefined {
  if (!fbclid) return undefined;
  return `fb.1.${tsMs}.${fbclid}`;
}
