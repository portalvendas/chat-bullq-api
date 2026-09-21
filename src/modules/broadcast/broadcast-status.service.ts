import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { BroadcastPricingService } from './pricing.service';
import { BroadcastService } from './broadcast.service';

export interface WaStatusEvent {
  wamid: string;
  status: string; // sent | delivered | read | failed
  timestamp?: Date;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/**
 * Reconciliação por webhook: casa o `wamid` com o destinatário do disparo,
 * avança o status e COBRA por ENTREGA (idempotente por `billedAmountMicros`).
 * Ao zerar as pendências, finaliza a campanha (RELEASE + custo real).
 *
 * O custo real da Meta viria no `pricing` do webhook; como o pipeline atual não
 * o carrega, cobramos pela categoria do template no rate card (mesmo repasse).
 */
@Injectable()
export class BroadcastStatusService {
  private readonly logger = new Logger(BroadcastStatusService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: BroadcastPricingService,
    private readonly broadcast: BroadcastService,
  ) {}

  /** Trata um status de mensagem; no-op silencioso se o wamid não é de disparo. */
  async handleStatus(ev: WaStatusEvent): Promise<void> {
    if (!ev.wamid) return;
    const recipient = await this.prisma.broadcastRecipient.findUnique({
      where: { wamid: ev.wamid },
      include: {
        broadcast: { select: { id: true, organizationId: true, templateCategory: true } },
      },
    });
    if (!recipient) return; // não é de um disparo

    try {
      switch (ev.status) {
        case 'sent':
          await this.advance(recipient.id, 'SENT', { sentAt: ev.timestamp });
          break;
        case 'delivered':
          await this.advance(recipient.id, 'DELIVERED', { deliveredAt: ev.timestamp });
          await this.charge(recipient);
          break;
        case 'read':
          await this.advance(recipient.id, 'READ', { readAt: ev.timestamp });
          await this.charge(recipient); // idempotente (caso delivered não tenha vindo)
          break;
        case 'failed':
          await this.prisma.broadcastRecipient.update({
            where: { id: recipient.id },
            data: {
              status: 'FAILED',
              errorCode: ev.errorCode ?? undefined,
              errorMessage: ev.errorMessage?.slice(0, 500) ?? undefined,
            },
          });
          break;
        default:
          return;
      }
      await this.broadcast.finalizeIfDone(recipient.broadcast.id);
    } catch (err: any) {
      this.logger.warn(
        `handleStatus falhou wamid=${ev.wamid}: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Rede de segurança: destrava disparos com destinatários presos em SENT há
   * mais de `hours` sem webhook de entrega. Marca DELIVERED SEM cobrar (não
   * temos o recibo real — a sobra da reserva volta via RELEASE) e finaliza a
   * campanha. Retorna quantos foram reconciliados.
   */
  async reconcileStaleSent(hours = 6, batch = 500): Promise<number> {
    const cutoff = new Date(Date.now() - hours * 3600_000);
    const stale = await this.prisma.broadcastRecipient.findMany({
      where: {
        status: 'SENT',
        updatedAt: { lt: cutoff },
        broadcast: { status: 'RUNNING' },
      },
      select: { id: true, broadcastId: true },
      take: batch,
    });
    if (!stale.length) return 0;

    await this.prisma.broadcastRecipient.updateMany({
      where: { id: { in: stale.map((s) => s.id) } },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
    });
    const broadcastIds = [...new Set(stale.map((s) => s.broadcastId))];
    for (const bId of broadcastIds) {
      await this.broadcast.finalizeIfDone(bId).catch(() => undefined);
    }
    this.logger.warn(
      `reconcile: ${stale.length} destinatário(s) SENT>${hours}h marcados DELIVERED (sem cobrança)`,
    );
    return stale.length;
  }

  /** Avança o status só pra frente (não regride READ→DELIVERED). */
  private async advance(
    recipientId: string,
    to: 'SENT' | 'DELIVERED' | 'READ',
    times: { sentAt?: Date; deliveredAt?: Date; readAt?: Date },
  ) {
    const rank: Record<string, number> = {
      PENDING: 0, QUEUED: 1, SENT: 2, DELIVERED: 3, READ: 4,
    };
    const rec = await this.prisma.broadcastRecipient.findUnique({
      where: { id: recipientId },
      select: { status: true },
    });
    if (!rec) return;
    const cur = rank[rec.status] ?? -1;
    const next = rank[to];
    const data: any = { ...times };
    if (next > cur) data.status = to;
    if (Object.keys(data).length) {
      await this.prisma.broadcastRecipient.update({
        where: { id: recipientId },
        data,
      });
    }
  }

  /**
   * CHARGE idempotente: reserva o slot (billedAmountMicros null → valor) via
   * updateMany atômico; só grava o lançamento se ganhou a corrida.
   */
  private async charge(recipient: {
    id: string;
    broadcast: { id: string; organizationId: string; templateCategory: any };
  }) {
    const unit = await this.pricing.getUnitMicros(
      'BR',
      recipient.broadcast.templateCategory,
    );
    const won = await this.prisma.broadcastRecipient.updateMany({
      where: { id: recipient.id, billedAmountMicros: null },
      data: {
        billedAmountMicros: unit,
        billedCategory: recipient.broadcast.templateCategory,
      },
    });
    if (won.count === 0) return; // já cobrado
    if (unit > 0n) {
      await this.prisma.broadcastLedgerEntry.create({
        data: {
          organizationId: recipient.broadcast.organizationId,
          broadcastId: recipient.broadcast.id,
          type: 'CHARGE',
          amountMicros: unit,
          note: `entrega ${recipient.id}`,
        },
      });
    }
  }
}
