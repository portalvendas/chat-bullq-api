/**
 * RODÍZIO PONDERADO DETERMINÍSTICO (smooth weighted round-robin).
 *
 * Em vez de sortear, monta a SEQUÊNCIA fixa de vendedoras de um ciclo, já
 * intercalada de forma suave, e o lead nº N do funil vai para a posição
 * N mod tamanho-do-ciclo. Não há aleatoriedade: a diferença entre o que cada
 * uma recebeu e a sua proporção nunca passa de 1 lead.
 *
 *   50/50       → [A, B]                      (A, B, A, B, ...)
 *   70/30       → [A, A, B, A, A, B, A, B, A, A]  (7 × 3 a cada 10, intercalado)
 *   40/40/20    → [A, B, C, A, B]
 *
 * A ordem das vendedoras é estável (por id) para o ciclo não "pular" entre
 * chamadas.
 */
export interface RotationWeight {
  userId: string;
  weight: number;
}

const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));

export function rotationSequence(weights: RotationWeight[]): string[] {
  const valid = weights
    .filter((w) => w.userId && Number(w.weight) > 0)
    .map((w) => ({ userId: w.userId, weight: Math.round(Number(w.weight)) }))
    .filter((w) => w.weight > 0)
    .sort((a, b) => a.userId.localeCompare(b.userId));
  if (!valid.length) return [];
  // Reduz pelos divisores comuns: 50/50 vira 1/1 (ciclo de 2, não de 100).
  const g = valid.reduce((acc, w) => gcd(acc, w.weight), valid[0].weight);
  const reduced = valid.map((w) => ({ ...w, weight: w.weight / g }));
  const total = reduced.reduce((s, w) => s + w.weight, 0);
  const current = reduced.map(() => 0);
  const seq: string[] = [];
  for (let i = 0; i < total; i++) {
    let best = 0;
    for (let j = 0; j < reduced.length; j++) {
      current[j] += reduced[j].weight;
      if (current[j] > current[best]) best = j;
    }
    current[best] -= total;
    seq.push(reduced[best].userId);
  }
  return seq;
}

/** Vendedora da vez para o lead de número `n` (0, 1, 2, ...). */
export function rotationPick(weights: RotationWeight[], n: number): string | null {
  const seq = rotationSequence(weights);
  if (!seq.length) return null;
  const i = ((n % seq.length) + seq.length) % seq.length;
  return seq[i];
}
