import { MICROS_PER_BRL } from './broadcast.constants';

/** Converte micros de BRL para número em reais (para exibição/serialização). */
export function microsToBRLNumber(micros: bigint): number {
  // Divide preservando 2 casas via centavos inteiros (evita float no divisor).
  const cents = Number((micros * 100n) / MICROS_PER_BRL);
  return cents / 100;
}

/** "R$ 0,34" a partir de micros. */
export function formatBRL(micros: bigint): string {
  return microsToBRLNumber(micros).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}

/**
 * Serializa BigInt → string recursivamente. O JSON do Nest NÃO serializa
 * BigInt (lança TypeError), então todo retorno de API que carregue micros
 * passa por aqui. Mantém a precisão inteira dos micros.
 */
export function serializeBigInt<T>(value: T): T {
  if (typeof value === 'bigint') return value.toString() as unknown as T;
  if (Array.isArray(value)) return value.map((v) => serializeBigInt(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = serializeBigInt(v);
    return out as T;
  }
  return value;
}
