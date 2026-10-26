import { rotationPick, rotationSequence } from './lead-rotation.util';

describe('rotationSequence', () => {
  it('50/50 alterna 1 a 1', () => {
    const seq = Array.from({ length: 6 }, (_, n) =>
      rotationPick([{ userId: 'a', weight: 50 }, { userId: 'b', weight: 50 }], n),
    );
    expect(seq).toEqual(['a', 'b', 'a', 'b', 'a', 'b']);
  });

  it('70/30 dá 7 × 3 a cada 10, intercalado (nunca 3 seguidos da menor)', () => {
    const seq = rotationSequence([{ userId: 'a', weight: 70 }, { userId: 'b', weight: 30 }]);
    expect(seq).toHaveLength(10);
    expect(seq.filter((x) => x === 'a')).toHaveLength(7);
    expect(seq.join('')).not.toContain('bb');
  });

  it('desvio máximo de 1 lead em qualquer prefixo (50/50)', () => {
    let a = 0;
    let b = 0;
    for (let n = 0; n < 101; n++) {
      rotationPick([{ userId: 'a', weight: 1 }, { userId: 'b', weight: 1 }], n) === 'a' ? a++ : b++;
      expect(Math.abs(a - b)).toBeLessThanOrEqual(1);
    }
  });

  it('ignora peso zero e lista vazia', () => {
    expect(rotationSequence([{ userId: 'a', weight: 0 }])).toEqual([]);
    expect(rotationPick([], 3)).toBeNull();
  });
});
