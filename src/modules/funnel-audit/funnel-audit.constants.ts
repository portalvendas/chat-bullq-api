/** Constantes/tipos da fila da Auditoria de Funil. Fica isolado pra NÃO criar
 *  import circular entre o processor e o service. */
export const FUNNEL_AUDIT_QUEUE = 'funnel-audit';
export const FUNNEL_AUDIT_JOB = 'run-audit';
/** Disparo agendado: enfileira um run por empresa. */
export const FUNNEL_AUDIT_SCHEDULE_JOB = 'schedule-audits';

export interface FunnelAuditJobData {
  runId: string;
  organizationId: string;
  /** Funis a analisar. Vazio/ausente = todos os ativos. */
  pipelineIds?: string[];
}
