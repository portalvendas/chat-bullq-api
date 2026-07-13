import { IdempotencyService } from './idempotency.service';

/**
 * Regressão de PERSISTÊNCIA: um processamento que FALHA precisa LIBERAR o
 * claim de idempotência, senão o retry do BullMQ vê a chave ainda setada,
 * pula a mensagem como "duplicada" e ela nunca é persistida (perda silenciosa).
 *
 * Bug original: o catch chamava `markProcessed` (que REGRAVA a chave) em vez
 * de `releaseProcessing` (que APAGA). Estes testes travam o comportamento
 * correto.
 *
 * Requer um transformer de TS pro jest (ts-jest/@swc/jest) — o repo ainda não
 * tem. Enquanto isso, a mesma verificação foi rodada via ts-node.
 */
class FakeRedis {
  store = new Map<string, string>();
  async set(key: string, val: string, ...args: any[]): Promise<'OK' | null> {
    const nx = args.includes('NX');
    if (nx && this.store.has(key)) return null;
    this.store.set(key, val);
    return 'OK';
  }
  async del(key: string): Promise<number> {
    return this.store.delete(key) ? 1 : 0;
  }
  async exists(key: string): Promise<number> {
    return this.store.has(key) ? 1 : 0;
  }
  disconnect(): void {}
}

function makeService(): any {
  const svc: any = new IdempotencyService({ get: (_k: string, d: any) => d } as any);
  try {
    svc.redis.disconnect();
  } catch {
    /* noop */
  }
  svc.redis = new FakeRedis();
  return svc;
}

describe('IdempotencyService — persistência em falha', () => {
  const ID = 'msg-1';
  const CH = 'chan-1';

  it('primeiro claim vence e o repetido é barrado como duplicata', async () => {
    const svc = makeService();
    expect(await svc.claimProcessing(ID, CH)).toBe(true);
    expect(await svc.claimProcessing(ID, CH)).toBe(false);
  });

  it('releaseProcessing libera o claim → retry re-adquire e reprocessa (FIX)', async () => {
    const svc = makeService();
    await svc.claimProcessing(ID, CH);
    await svc.releaseProcessing(ID, CH);
    expect(await svc.claimProcessing(ID, CH)).toBe(true);
  });

  it('markProcessed NÃO libera (documenta o bug antigo = perda de mensagem)', async () => {
    const svc = makeService();
    await svc.claimProcessing(ID, CH);
    await svc.markProcessed(ID, CH);
    expect(await svc.claimProcessing(ID, CH)).toBe(false);
  });
});
