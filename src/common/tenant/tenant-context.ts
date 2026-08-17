import { AsyncLocalStorage } from 'async_hooks';

/**
 * Contexto de tenant por requisição (multi-empresa).
 *
 * Guardado num AsyncLocalStorage: um middleware global cria o store no
 * início de cada request HTTP e o OrgGuard grava o `organizationId` depois
 * de validar a associação do usuário. O tenant-guard do Prisma
 * (prisma.service) lê daqui pra detectar queries de tenant SEM filtro de org.
 *
 * Fora de request HTTP (jobs BullMQ, crons, boot) NÃO há store — nesses
 * casos o guard NÃO age (esses fluxos resolvem a org por conta própria a
 * partir de dados confiáveis, e legitimamente cruzam orgs).
 */
export interface TenantStore {
  organizationId?: string;
  userId?: string;
  /** Origem do contexto, pra log/debug (ex.: 'http'). */
  source?: string;
}

const storage = new AsyncLocalStorage<TenantStore>();

/** Roda `fn` dentro de um novo store de tenant (usado pelo middleware). */
export function runWithTenant<T>(store: TenantStore, fn: () => T): T {
  return storage.run(store, fn);
}

/** Store do request atual (ou undefined fora de request). */
export function getTenantContext(): TenantStore | undefined {
  return storage.getStore();
}

/** Grava a org no store do request atual (chamado pelo OrgGuard). */
export function setTenantOrg(organizationId: string, userId?: string): void {
  const s = storage.getStore();
  if (s) {
    s.organizationId = organizationId;
    if (userId) s.userId = userId;
  }
}
