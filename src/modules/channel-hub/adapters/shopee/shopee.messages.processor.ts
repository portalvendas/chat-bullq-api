import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../../../../database/prisma.service';
import { ShopeeMessageMapper } from './shopee.message-mapper';
import { WebhookEventsService } from '../../webhook-events.service';

interface ShopeeInboundJob {
  channelId: string;
  organizationId: string;
  /** `data` do push do Shopee (mensagem de chat). */
  data: any;
  /** Id do WebhookEvent cru gravado no controller — pra marcar processed/failed. */
  webhookEventId?: string;
}

/**
 * Passo 2 do webhook do Shopee: recebe o push de chat enfileirado, normaliza a
 * mensagem do comprador e joga na fila `inbound-messages` — reaproveitando todo
 * o pipeline de inbox (idempotência por externalMessageId).
 * Fase 1: só mensagens de chat do comprador.
 */
@Processor('shopee-inbound', { concurrency: 5 })
export class ShopeeMessagesProcessor extends WorkerHost {
  private readonly logger = new Logger(ShopeeMessagesProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly mapper: ShopeeMessageMapper,
    private readonly webhookEvents: WebhookEventsService,
    @InjectQueue('inbound-messages') private readonly inboundQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<ShopeeInboundJob>): Promise<void> {
    const { channelId, organizationId, data, webhookEventId } = job.data;
    try {
      await this.handle(channelId, organizationId, data);
      if (webhookEventId) await this.webhookEvents.markProcessed(webhookEventId);
    } catch (err: any) {
      if (webhookEventId) {
        await this.webhookEvents.markFailed(
          webhookEventId,
          err?.message ?? String(err),
        );
      }
      throw err; // deixa o BullMQ re-tentar
    }
  }

  private async handle(
    channelId: string,
    organizationId: string,
    data: any,
  ): Promise<void> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    });
    if (!channel) {
      this.logger.warn(`Canal Shopee não encontrado: ${channelId}`);
      return;
    }

    // sellerUserId (se guardado) filtra eco das mensagens que NÓS enviamos.
    const cfg = (channel.config ?? {}) as Record<string, any>;
    const sellerUserId = cfg.sellerUserId ?? cfg.shopUserId;

    const message = this.mapper.normalizeChatMessage(data, sellerUserId);
    if (!message) {
      // Eco do vendedor ou payload não-normalizável — ignora silenciosamente.
      return;
    }

    await this.inboundQueue.add(
      'process-inbound',
      { channelId, organizationId, message },
      {
        attempts: 5,
        backoff: { type: 'exponential', delay: 2000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    this.logger.log(
      `Mensagem Shopee ${message.externalMessageId} → inbox (canal ${channelId})`,
    );
  }
}
