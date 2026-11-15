import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import { FUNNEL_AUDIT_QUEUE, FUNNEL_AUDIT_SCHEDULE_JOB } from './funnel-audit.constants';

/**
 * TICK da Auditoria de Funil: dispara a cada 5 min (BullMQ repeatable). O tick
 * NÃO roda a auditoria — ele chama `scheduleAll()`, que para CADA empresa
 * respeita a config dela (FunnelAuditConfig: liga/desliga, horários e dias, no
 * fuso São Paulo) e só dispara quando bate o horário. Assim cada org tem o
 * próprio agendamento, sem um cron por org.
 *
 * Ajustável por env FUNNEL_AUDIT_CRON (ex.: afrouxar/apertar o tick).
 * Idempotente entre réplicas pelo jobId.
 */
const REPEAT_PATTERN = process.env.FUNNEL_AUDIT_CRON || '*/5 * * * *';
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
