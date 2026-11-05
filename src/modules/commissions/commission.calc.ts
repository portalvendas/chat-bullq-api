/**
 * CÁLCULO DA COMISSÃO (função pura — sem banco, testável).
 *
 * Base = vendas do mês SÓ EM PRODUTOS (valor do pedido − frete/outras despesas).
 *
 *  - Abaixo da meta:   comissão = fixo.
 *  - Bateu a meta:     variável = percent × (base de cálculo do %):
 *                        EXCEDENTE → só o que passou da meta;
 *                        TOTAL     → tudo o que vendeu no mês.
 *                      comissão = (keepFixed ? fixo : 0) + variável.
 *  - Sem meta (0):     considera meta batida desde o 1º real.
 *
 * Exemplo (fixo 1.500, meta 40.000, 3% EXCEDENTE, mantém fixo):
 *   vendas 32.000 → 1.500 (80% da meta)
 *   vendas 50.000 → 1.500 + 3% × 10.000 = 1.800
 * Mesmo plano com TOTAL: vendas 50.000 → 1.500 + 3% × 50.000 = 3.000
 */
export type PercentBase = 'EXCEDENTE' | 'TOTAL';

export interface CommissionRule {
  fixedAmount: number;
  goalAmount: number;
  percent: number; // 3 = 3%
  percentBase: PercentBase;
  keepFixed: boolean;
}

export interface CommissionResult {
  vendas: number;
  meta: number;
  atingimento: number | null; // 0.8 = 80%; null sem meta
  bateuMeta: boolean;
  fixo: number;
  baseVariavel: number;
  variavel: number;
  total: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function calcCommission(vendas: number, rule: CommissionRule): CommissionResult {
  const v = Math.max(0, Number(vendas) || 0);
  const meta = Math.max(0, Number(rule.goalAmount) || 0);
  const fixoCfg = Math.max(0, Number(rule.fixedAmount) || 0);
  const pct = Math.max(0, Number(rule.percent) || 0) / 100;
  const bateu = v >= meta;

  let fixo = fixoCfg;
  let baseVariavel = 0;
  let variavel = 0;
  if (bateu) {
    baseVariavel = rule.percentBase === 'TOTAL' ? v : v - meta;
    variavel = baseVariavel * pct;
    if (!rule.keepFixed) fixo = 0;
  }
  return {
    vendas: r2(v),
    meta: r2(meta),
    atingimento: meta > 0 ? v / meta : null,
    bateuMeta: bateu,
    fixo: r2(fixo),
    baseVariavel: r2(baseVariavel),
    variavel: r2(variavel),
    total: r2(fixo + variavel),
  };
}

/** "AAAA-MM" → [início, fim] do mês em Brasília, como instantes UTC. */
export function monthRange(month: string): { from: Date; to: Date } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error('mês inválido (use AAAA-MM)');
  const y = +m[1];
  const mo = +m[2];
  const from = new Date(Date.UTC(y, mo - 1, 1, 3, 0, 0)); // 00:00 BRT
  const to = new Date(Date.UTC(y, mo, 1, 3, 0, 0) - 1); // 23:59:59.999 BRT do último dia
  return { from, to };
}
