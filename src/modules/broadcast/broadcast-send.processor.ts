import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, DelayedError } from 'bullmq';
import { PrismaService } from '../../database/prisma.service';
import { WaRateLimiter } from './wa-rate-limiter';
import { BroadcastWaSender, WaSendError } from './broadcast-wa.sender';
import { buildTemplatePayload } from './template-payload';
import { BROADCAST_SEND_QUEUE } from './broadcast.constants';

interface SendJobData {
  recipientId: string;
  broadcastId: string;
  perMinute: number;
}

/**
 * Worker de envio: 1 job = 1 destinatário. Idempotente (só PENDING/QUEUED
 * seguem), respeita opt-out tardio, throttla por número/campanha (re-agenda com
 * DelayedError) e classifica o erro da Meta em permanente (FAILED) ou
 * transitório (throw → backoff).
 */
@Processor(BROADCAST_SEND_QUEUE, {
  concurrency: Number(process.env.BROADCAST_CONCURRENCY ?? 20),
})
export class BroadcastSendProcessor extends WorkerHost {
  private readonly logger = new Logger(BroadcastSendProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly limiter: WaRateLimiter,
    private readonly sender: BroadcastWaSender,
    private readonly _config: ConfigService,
  ) {
    super();
  }

  async process(job: Job<SendJobData>): Promise<{ status: string }> {
    const { recipientId, perMinute } = job.data;

    const recipient = await this.prisma.broadcastRecipient.findUnique({
      where: { id: recipientId },
      include: {
        contact: {
          select: {
            name: true,
            phone: true,
            email: true,
            broadcastOptedOutAt: true,
          },
        },
        broadcast: {
          select: { status: true, templateName: true, templateLanguage: true, variablesMapping: true, channelId: true },
        },
      },
    });
    if (!recipient) return { status: 'gone' };

    // Idempotência: já resolvido em outra tentativa.
    if (!['PENDING', 'QUEUED'].includes(recipient.status)) {
      return { status: `noop:${recipient.status}` };
    }
    // Campanha não está mais rodando (pausada/cancelada) → não envia.
    if (recipient.broadcast.status !== 'RUNNING') {
      return { status: `skip:${recipient.broadcast.status}` };
    }
    // Opt-out tardio (o cliente saiu depois de materializar).
    if (recipient.contact.broadcastOptedOutAt) {
      await this.setStatus(recipientId, 'OPTED_OUT');
      return { status: 'opted_out' };
    }

    const channel = await this.prisma.channel.findUnique({
      where: { id: recipient.broadcast.channelId },
    });
    if (!channel) {
      await this.fail(recipientId, 'no_channel', 'Canal não encontrado');
      return { status: 'no_channel' };
    }

    // Throttle: se estourou a janela, re-agenda o mesmo job.
    const wait = await this.limiter.waitMs(
      this.sender.phoneNumberId(channel),
      recipient.broadcastId,
      perMinute,
    );
    if (wait > 0) {
      await job.moveToDelayed(Date.now() + wait, job.token);
      throw new DelayedError();
    }

    const payload = buildTemplatePayload({
      to: recipient.phoneE164,
      templateName: recipient.broadcast.templateName,
      language: recipient.broadcast.templateLanguage,
      mapping: recipient.broadcast.variablesMapping as any,
      contact: recipient.contact,
    });

    try {
      const { wamid } = await this.sender.sendTemplate(channel, payload);
      await this.prisma.broadcastRecipient.update({
        where: { id: recipientId },
        data: {
          status: 'SENT',
          wamid: wamid ?? undefined,
          sentAt: new Date(),
          errorCode: null,
          errorMessage: null,
        },
      });
      return { status: 'sent' };
    } catch (err: any) {
      if (err instanceof WaSendError && err.permanent) {
        await this.fail(recipientId, err.code ?? 'permanent', err.message);
        this.logger.warn(
          `broadcast_send FAILED recipient=${recipientId} code=${err.code} msg=${err.message}`,
        );
        return { status: 'failed' };
      }
      // Transitório → deixa o BullMQ retentar (backoff).
      throw err;
    }
  }

  private async setStatus(id: string, status: any) {
    await this.prisma.broadcastRecipient.update({
      where: { id },
      data: { status },
    });
  }

  private async fail(id: string, code: string, message: string) {
    await this.prisma.broadcastRecipient.update({
      where: { id },
      data: { status: 'FAILED', errorCode: code, errorMessage: message?.slice(0, 500) },
    });
  }
}
