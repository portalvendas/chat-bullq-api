import { computeRecoveryOffer } from './offer-policy';

describe('computeRecoveryOffer', () => {
  it('proposta sem desconto, frete ≤5% → Pix 13% c/ frete pago; cartão 5% + 10x + frete grátis', () => {
    const o = computeRecoveryOffer({ grossProducts: 3890, vendorDiscount: 0, shipping: 180 });
    expect(o.freeShippingEligible).toBe(true); // 180/3890 = 4,63%
    expect(o.pix).toMatchObject({ available: true, totalDiscountPct: 13, productsTotal: 3384.3, shipping: 180, total: 3564.3 });
    expect(o.card).toMatchObject({ available: true, totalDiscountPct: 5, freeShipping: true, total: 3695.5, installmentValue: 369.55 });
  });

  it('vendedor deu 8% → Pix completa até 13% (+5pp); cartão indisponível (>5%)', () => {
    const o = computeRecoveryOffer({ grossProducts: 4000, vendorDiscount: 320, shipping: 250 });
    expect(o.pix).toMatchObject({ available: true, totalDiscountPct: 13, extraDiscountPct: 5, productsTotal: 3480, total: 3730 });
    expect(o.card.available).toBe(false);
    expect(o.freeShippingEligible).toBe(false); // 250/3680 = 6,79%
  });

  it('vendedor deu 3% → cartão sobe pra 5%; Pix 13%', () => {
    const o = computeRecoveryOffer({ grossProducts: 1000, vendorDiscount: 30, shipping: 0 });
    expect(o.card).toMatchObject({ available: true, totalDiscountPct: 5, total: 950, freeShipping: false });
    expect(o.pix).toMatchObject({ available: true, extraDiscountPct: 10, total: 870 });
  });

  it('vendedor já deu 13%+ → nada a oferecer', () => {
    const o = computeRecoveryOffer({ grossProducts: 1000, vendorDiscount: 150, shipping: 40 });
    expect(o.hasAnyOption).toBe(false);
  });

  it('frete exatamente 5% dos produtos → elegível', () => {
    const o = computeRecoveryOffer({ grossProducts: 2000, vendorDiscount: 0, shipping: 100 });
    expect(o.freeShippingEligible).toBe(true);
  });
});
