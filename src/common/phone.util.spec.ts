import { canonicalPhone, canonicalizePhoneField, phoneVariants } from './phone.util';

describe('canonicalPhone', () => {
  it.each([
    ['557388688598', '5573988688598'], // WhatsApp sem o 9 (caso Daiane)
    ['5573988688598', '5573988688598'], // já canônico
    ['(73) 98868-8598', '5573988688598'], // formulário com máscara
    ['7388688598', '5573988688598'], // nacional sem 9
    ['+55 46 99987-9210', '5546999879210'],
    ['554632221234', '554632221234'], // fixo (começa com 3) não ganha 9
    ['14155550123', '14155550123'], // estrangeiro: só dígitos
    ['55319961539', '55319961539'], // truncado pela máscara da LP: não inventa
  ])('%s → %s', (input, expected) => {
    expect(canonicalPhone(input)).toBe(expected);
  });

  it('vazio → null', () => {
    expect(canonicalPhone('')).toBeNull();
    expect(canonicalPhone(null)).toBeNull();
  });

  it('forma canônica está entre as variantes do JID sem 9', () => {
    expect(phoneVariants('557388688598')).toContain(canonicalPhone('557388688598'));
  });
});

describe('canonicalizePhoneField', () => {
  it('valor direto', () => {
    expect(canonicalizePhoneField({ name: 'x', phone: '557388688598' })).toEqual({
      name: 'x',
      phone: '5573988688598',
    });
  });
  it('{ set }', () => {
    expect(canonicalizePhoneField({ phone: { set: '557388688598' } })).toEqual({
      phone: { set: '5573988688598' },
    });
  });
  it('sem phone / null não mexe', () => {
    const a = { name: 'x' };
    expect(canonicalizePhoneField(a)).toBe(a);
    expect(canonicalizePhoneField({ phone: null })).toEqual({ phone: null });
  });
  it("'' vira null", () => {
    expect(canonicalizePhoneField({ phone: '' })).toEqual({ phone: null });
  });
});
