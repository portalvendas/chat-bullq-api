/**
 * Motor de oferta da Recuperação de Orçamentos — FUNÇÃO PURA.
 *
 * Quem calcula é o código, nunca o LLM: o agente só apresenta os números que
 * saem daqui (via tool getRecoveryOffer). Valores em centavos internamente
 * pra não acumular erro de ponto flutuante.
 *
 * Política comercial (decidida pelo Diogo, 2026-11-15):
 * - Teto: 5% padrão + 8% Pix = 13% no Pix  OU  5% padrão + cartão até 10x sem juros.
 * - O desconto que o vendedor já deu CONTA DENTRO do teto (o agente só completa).
 * - Cartão 10x: só se a proposta não tem desconto ou tem até 5%.
 * - Frete grátis: quando frete ≤ 5% do valor dos PRODUTOS da proposta.
 *   Combina com cartão; NUNCA com o desconto do Pix (oferta única).
 * - Condição vale 48h (escassez real, imposta pelo sistema — ver offerExpiresAt).
 */

export interface RecoveryPolicy {
  /** Desconto padrão aplicado a todas as propostas (%). */
  standardDiscountPct: number;
  /** Desconto extra do Pix, ALÉM do padrão (%). */
  pixExtraDiscountPct: number;
  /** Desconto total no cartão (%), que é o padrão. */
  cardDiscountPct: number;
  /** Cartão só é oferecido se o desconto do vendedor for ≤ isso (%). */
  cardMaxVendorDiscountPct: number;
  cardMaxInstallments: number;
  /** Frete grátis quando frete/produtos ≤ isso (%). */
  freeShippingMaxPct: number;
  /** Validade da condição a partir da abordagem (h). */
  offerValidityHours: number;
}

export const DEFAULT_RECOVERY_POLICY: RecoveryPolicy = {
  standardDiscountPct: 5,
  pixExtraDiscountPct: 8,
  cardDiscountPct: 5,
  cardMaxVendorDiscountPct: 5,
  cardMaxInstallments: 10,
  freeShippingMaxPct: 5,
  offerValidityHours: 48,
};

/** Números da proposta como saiu do Tiny (em reais). */
export interface ProposalFinancials {
  /** Total dos produtos SEM desconto (valorTotalProdutos do Tiny). */
  grossProducts: number;
  /** Desconto já aplicado pelo vendedor (valorDesconto do Tiny). 0 = nenhum. */
  vendorDiscount: number;
  /** Frete da proposta. */
  shipping: number;
}

export interface PixOption {
  available: true;
  totalDiscountPct: number;
  /** Quanto o agente está somando além do que o vendedor já deu (pp). */
  extraDiscountPct: number;
  productsTotal: number;
  shipping: number;
  total: number;
  /** Quanto o cliente economiza vs. a proposta original. */
  savings: number;
}

export interface CardOption {
  available: true;
  totalDiscountPct: number;
  maxInstallments: number;
  installmentValue: number;
  freeShipping: boolean;
  productsTotal: number;
  shipping: number;
  total: number;
  savings: number;
}

export interface Unavailable {
  available: false;
  reason: string;
}

export interface RecoveryOffer {
  original: {
    grossProducts: number;
    vendorDiscount: number;
    vendorDiscountPct: number;
    productsTotal: number;
    shipping: number;
    total: number;
  };
  shippingPctOfProducts: number | null;
  freeShippingEligible: boolean;
  pix: PixOption | Unavailable;
  card: CardOption | Unavailable;
  /** true se há ao menos uma condição pra oferecer. */
  hasAnyOption: boolean;
  policy: RecoveryPolicy;
}

const toCents = (v: number) => Math.round((Number.isFinite(v) ? v : 0) * 100);
const fromCents = (c: number) => c / 100;
const round2 = (n: number) => Math.round(n * 100) / 100;

export function computeRecoveryOffer(
  input: ProposalFinancials,
  policy: RecoveryPolicy = DEFAULT_RECOVERY_POLICY,
): RecoveryOffer {
  const gross = Math.max(0, toCents(input.grossProducts));
  const vendorDisc = Math.min(gross, Math.max(0, toCents(input.vendorDiscount)));
  const shipping = Math.max(0, toCents(input.shipping));

  const vendorPct = gross > 0 ? round2((vendorDisc / gross) * 100) : 0;
  const productsAsSent = gross - vendorDisc;
  const originalTotal = productsAsSent + shipping;

  // Frete ≤ 5% do valor dos PRODUTOS da proposta (como enviada).
  const shippingPct =
    productsAsSent > 0 && shipping > 0
      ? round2((shipping / productsAsSent) * 100)
      : null;
  const freeShippingEligible =
    shippingPct !== null && shippingPct <= policy.freeShippingMaxPct;

  const priceWith = (pct: number) => Math.round(gross * (1 - pct / 100));

  // ── Pix: completa até padrão + extra (o desconto do vendedor conta dentro).
  const pixTarget = policy.standardDiscountPct + policy.pixExtraDiscountPct;
  let pix: PixOption | Unavailable;
  if (gross <= 0) {
    pix = { available: false, reason: 'proposta_sem_valor_de_produtos' };
  } else if (vendorPct >= pixTarget) {
    pix = { available: false, reason: 'desconto_do_vendedor_ja_atinge_o_teto_pix' };
  } else {
    const products = priceWith(pixTarget);
    const total = products + shipping; // Pix NUNCA com frete grátis
    pix = {
      available: true,
      totalDiscountPct: pixTarget,
      extraDiscountPct: round2(pixTarget - vendorPct),
      productsTotal: fromCents(products),
      shipping: fromCents(shipping),
      total: fromCents(total),
      savings: fromCents(originalTotal - total),
    };
  }

  // ── Cartão: até 10x, desconto padrão, só se vendedor deu ≤ 5%.
  let card: CardOption | Unavailable;
  if (gross <= 0) {
    card = { available: false, reason: 'proposta_sem_valor_de_produtos' };
  } else if (vendorPct > policy.cardMaxVendorDiscountPct) {
    card = { available: false, reason: 'desconto_do_vendedor_acima_do_limite_do_cartao' };
  } else {
    const pct = Math.max(policy.cardDiscountPct, vendorPct);
    const products = priceWith(pct);
    const cardShipping = freeShippingEligible ? 0 : shipping;
    const total = products + cardShipping;
    card = {
      available: true,
      totalDiscountPct: round2(pct),
      maxInstallments: policy.cardMaxInstallments,
      installmentValue: fromCents(Math.round(total / policy.cardMaxInstallments)),
      freeShipping: freeShippingEligible,
      productsTotal: fromCents(products),
      shipping: fromCents(cardShipping),
      total: fromCents(total),
      savings: fromCents(originalTotal - total),
    };
  }

  return {
    original: {
      grossProducts: fromCents(gross),
      vendorDiscount: fromCents(vendorDisc),
      vendorDiscountPct: vendorPct,
      productsTotal: fromCents(productsAsSent),
      shipping: fromCents(shipping),
      total: fromCents(originalTotal),
    },
    shippingPctOfProducts: shippingPct,
    freeShippingEligible,
    pix,
    card,
    hasAnyOption: pix.available || card.available,
    policy,
  };
}
