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

/** E-mail: trim + lowercase. */
export function hashEmail(email?: string | null): string | undefined {
  const e = clean(email);
  return e && e.includes('@') ? sha256(e) : undefined;
}

/**
 * Telefone: só dígitos, COM código do país (Brasil = 55). Remove +, espaços,
 * parênteses, traços. Se não vier com DDI, prefixa 55.
 */
export function hashPhone(phone?: string | null): string | undefined {
  let d = (phone ?? '').replace(/\D/g, '');
  if (!d) return undefined;
  if (!d.startsWith('55')) d = '55' + d;
  return sha256(d);
}

/** Nome/sobrenome/cidade: lowercase, sem espaços nas pontas. */
export function hashName(v?: string | null): string | undefined {
  const s = clean(v);
  return s ? sha256(s) : undefined;
}

/** Cidade: lowercase, sem espaços/pontuação. */
export function hashCity(v?: string | null): string | undefined {
  const s = clean(v).replace(/[^a-z0-9]/g, '');
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
