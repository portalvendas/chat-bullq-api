/**
 * Queue names extraídos pra arquivo neutro — evita ciclo de imports TS:
 *   pending-action.service → pending-action-executor.processor (const)
 *   pending-action-executor.processor → tools/http-tool-executor (DI)
 *   tools/http-tool-executor → pending-action.service (DI)
 *
 * Sem esse arquivo, Node carrega o ciclo e um dos exports vira undefined
 * em runtime, mesmo com NestJS resolvendo os modules corretamente.
 */
export const PENDING_ACTION_EXECUTOR_QUEUE = 'pending-action-executor';
export const PENDING_EXECUTE_JOB = 'execute_pending';
export const PENDING_EXPIRE_JOB = 'expire_overdue';
