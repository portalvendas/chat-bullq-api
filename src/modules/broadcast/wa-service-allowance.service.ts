import { Injectable, Logger } from '@nestjs/common';
import { MessageCategory, NotificationType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';

const SERVICE_FREE = 1000; // franquia grátis de mensagens de serviço/número/mês
const ALERT_THRESHOLD = Math.floor(SERVICE_FREE * 0.8); // 80% = 800

/**
 * P4 — Alerta de franquia de serviço (mudança Meta out/2026: mensagens de
 * serviço acima de 1.000/número/mês passam a ser cobradas). Verifica o ledger
 * `wa_message_costs` e notifica os agentes da org (in-app) quando um número
 * passa de 80% da franquia no mês. Trava de 1x/dia (guarda em memória) pra não
 * spammar. Best-effort: nunca derruba o cron que o chama.
 */
@Injectable()
export class WaServiceAllowanceService {
  private readonly logger = new Logger(WaServiceAllowanceService.name);
  private lastRunDay: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  async checkAndAlert(): Promise<{ alerted: number }> {
    const today = new Date().toISOString().slice(0, 10);
    if (this.lastRunDay === today) return { alerted: 0 };
    this.lastRunDay = today;

    try {
      const now = new Date();
      const monthStart = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
      );
      const grouped = (await this.prisma.waMessageCost.groupBy({
        by: ['organizationId', 'channelId'],
        where: {
          category: MessageCategory.SERVICE,
          occurredAt: { gte: monthStart },
        },
        _count: { _all: true },
      })) as Array<{
        organizationId: string;
        channelId: string;
        _count: { _all: number };
      }>;
      const over = grouped.filter((g) => g._count._all >= ALERT_THRESHOLD);
      if (!over.length) return { alerted: 0 };

      const channels = await this.prisma.channel.findMany({
        where: { id: { in: over.map((g) => g.channelId) } },
        select: { id: true, name: true },
      });
      const nameOf = new Map(channels.map((c) => [c.id, c.name]));

      let alerted = 0;
      for (const g of over) {
        const used = g._count._all;
        const pct = Math.round((used / SERVICE_FREE) * 100);
        const name = nameOf.get(g.channelId) ?? g.channelId;
        const estourou = used >= SERVICE_FREE;
        await this.notifications.notifyOrgAgents({
          organizationId: g.organizationId,
          type: NotificationType.SYSTEM,
          title: estourou
            ? `WhatsApp: franquia de serviço estourada (${name})`
            : `WhatsApp: franquia de serviço em ${pct}% (${name})`,
          body: estourou
            ? `O número ${name} já usou ${used} de ${SERVICE_FREE} mensagens de serviço grátis no mês — o excedente já está sendo cobrado. Considere balancear o atendimento entre os números.`
            : `O número ${name} já usou ${used} de ${SERVICE_FREE} mensagens de serviço grátis no mês (${pct}%). Ao passar de ${SERVICE_FREE}, o excedente passa a ser cobrado.`,
          data: {
            kind: 'wa_service_allowance',
            channelId: g.channelId,
            used,
            free: SERVICE_FREE,
            pct,
          },
        });
        alerted++;
      }
      this.logger.log(`wa_service_allowance_alerts=${alerted}`);
      return { alerted };
    } catch (err: any) {
      this.logger.warn(
        `wa-service-allowance check falhou: ${err?.message ?? err}`,
      );
      return { alerted: 0 };
    }
  }
}
