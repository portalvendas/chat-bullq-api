import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { FUNNEL_AUDIT_QUEUE, FUNNEL_AUDIT_SCHEDULE_JOB } from './funnel-audit.constants';

/**
 * AGENDA da Auditoria de Funil: seg a sáb, 08:30, 12:30 e 16:30 (São Paulo).
 *
 *  - 08:30 → começo do expediente: o que ficou da noite/véspera (clientes que
 *    escreveram fora do horário, orçamentos sem retorno, cards parados).
 *  - 12:30 → antes do almoço terminar: leads da manhã sem contato.
 *  - 16:30 → dá tempo de agir antes de fechar o dia.
 *
 * Brasil não tem horário de verão (UTC-3 fixo) → no cron (UTC) fica 11:30,
 * 15:30, 19:30. Ajustável por env FUNNEL_AUDIT_CRON. BullMQ repeatable (padrão
 * do projeto), idempotente entre réplicas pelo jobId.
 */
const REPEAT_PATTERN = process.env.FUNNEL_AUDIT_CRON || '30 11,15,19 * * 1-6';
const REPEAT_JOB_ID = 'funnel-audit-schedule-cron';

@Injectable()
export class FunnelAuditCron implements OnModuleInit {
  private readonly logger = new Logger(FunnelAuditCron.name);

  constructor(@InjectQueue(FUNNEL_AUDIT_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    try {
      for (const r of await this.queue.getRepeatableJobs()) {
        if ((r.name === FUNNEL_AUDIT_SCHEDULE_JOB || r.id === REPEAT_JOB_ID) && r.pattern !== REPEAT_PATTERN) {
          await this.queue.removeRepeatableByKey(r.key);
        }
      }
      await this.queue.add(
        FUNNEL_AUDIT_SCHEDULE_JOB,
        {},
        { repeat: { pattern: REPEAT_PATTERN }, jobId: REPEAT_JOB_ID, removeOnComplete: 10, removeOnFail: 10 },
      );
      this.logger.log(`funnel_audit_schedule pattern=${REPEAT_PATTERN} (UTC)`);
    } catch (err: any) {
      this.logger.error(`Falha ao agendar auditoria de funil: ${err?.message ?? err}`);
    }
  }
}
