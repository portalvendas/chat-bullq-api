/** Categoria do AiAgent que recebe as ferramentas de recuperação. */
export const PROPOSAL_RECOVERY_AGENT_CATEGORY = 'proposal-recovery';

export const PROPOSAL_RECOVERY_QUEUE = 'proposal-recovery';
export const PROPOSAL_RECOVERY_SCAN_JOB = 'proposal-recovery-scan';

/** Status em que a recuperação ainda está "viva" na conversa. */
export const ACTIVE_RECOVERY_STATUSES = ['CONTACTED', 'ENGAGED'] as const;

/**
 * Situações de orçamento que NÃO devem ser recuperadas (comparação
 * case-insensitive). situacao NULL é o normal do orçamento no Tiny → elegível.
 */
export const ORCAMENTO_SITUACOES_EXCLUIDAS = [
  'removido',
  'cancelado',
  'cancelada',
  'aprovado',
  'aprovada',
  'não aprovado',
  'não aprovada',
  'nao aprovado',
  'nao aprovada',
  'reprovado',
  'reprovada',
  'concluído',
  'concluido',
];

/** Situações de pedido que não contam como venda (mesmo filtro do dashboard). */
export const PEDIDO_SITUACOES_EXCLUIDAS = ['Cancelada', 'Dados Incompletos', 'Removido'];

const num = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
};

/** Configuração operacional (env), com defaults da decisão de 2026-11-15. */
export const recoveryConfig = () => ({
  enabled: process.env.PROPOSAL_RECOVERY_ENABLED === 'true',
  /** Fase 1 = copiloto: a resposta do agente fica retida pro vendedor aprovar. */
  reviewMode: process.env.PROPOSAL_RECOVERY_REVIEW_MODE !== 'false',
  /** Janela de silêncio do cliente pra abordar (h). 23h = ainda dentro das 24h. */
  minSilenceHours: num(process.env.PROPOSAL_RECOVERY_MIN_SILENCE_HOURS, 23),
  maxSilenceHours: num(process.env.PROPOSAL_RECOVERY_MAX_SILENCE_HOURS, 23.75),
  /** Não aborda se houve mensagem NOSSA (vendedor/bot) nas últimas N horas. */
  skipIfOutboundWithinHours: num(process.env.PROPOSAL_RECOVERY_SKIP_OUTBOUND_HOURS, 4),
  /** Idade máxima do orçamento (dias). */
  maxProposalAgeDays: num(process.env.PROPOSAL_RECOVERY_MAX_PROPOSAL_AGE_DAYS, 45),
  /** Teto de abordagens por varredura (proteção anti-pico de envio). */
  maxKickoffsPerScan: num(process.env.PROPOSAL_RECOVERY_MAX_KICKOFFS_PER_SCAN, 20),
  channelTypes: (
    process.env.PROPOSAL_RECOVERY_CHANNEL_TYPES ??
    'WHATSAPP_OFFICIAL,WHATSAPP_ZAPI,WHATSAPP_ZAPPFY,WHATSAPP_BAILEYS'
  )
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
});
