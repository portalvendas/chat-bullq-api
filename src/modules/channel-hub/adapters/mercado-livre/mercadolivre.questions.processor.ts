import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../../../../database/prisma.service';
import { MercadoLivreHttpClient } from './mercadolivre.http-client';
import { MercadoLivreMessageMapper } from './mercadolivre.message-mapper';
import { WebhookEventsService } from '../../webhook-events.service';

interface MlInboundJob {
  channelId: string;
  organizationId: string;
  resource: string;
  topic: string;
  /** Id do WebhookEvent cru gravado no controller — pra marcar processed/failed. */
  webhookEventId?: string;
}

/**
 * Passo 2 do webhook do Mercado Livre: recebe a notificação enfileirada,
 * busca o recurso (GET /questions/{id}) com token válido, normaliza e joga
 * na fila `inbound-messages` — reaproveitando todo o pipeline de inbox.
 * Fase 1: só o tópico `questions`.
 */
@Processor('mercadolivre-inbound', { concurrency: 5 })
export class MercadoLivreQuestionsProcessor extends WorkerHost {
  private readonly logger = new Logger(MercadoLivreQuestionsProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpClient: MercadoLivreHttpClient,
    private readonly mapper: MercadoLivreMessageMapper,
    private readonly webhookEvents: WebhookEventsService,
    @InjectQueue('inbound-messages') private readonly inboundQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<MlInboundJob>): Promise<void> {
    const { channelId, organizationId, resource, topic, webhookEventId } =
      job.data;
    // Marca o evento cru como processado/falho no fim — replay se falhar.
    try {
      await this.handle(channelId, organizationId, resource, topic);
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
    resource: string,
    topic: string,
  ): Promise<void> {
    if (topic !== 'questions') return; // messages = Fase 2

    const match = /\/questions\/(\d+)/.exec(resource || '');
    if (!match) {
      this.logger.warn(`Resource sem question_id: ${resource}`);
      return;
    }
    const questionId = match[1];

    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    });
    if (!channel) {
      this.logger.warn(`Canal ML não encontrado: ${channelId}`);
      return;
    }

    const question = await this.httpClient.get(
      channel,
      `/questions/${questionId}?api_version=4`,
    );

    const message = this.mapper.normalizeQuestion(question);
    if (!message) {
      this.logger.warn(`Pergunta ${questionId} não normalizável`);
      return;
    }

    // Enriquece a pergunta com o ANÚNCIO (item_id vem no payload). O operador
    // vê qual anúncio, e o agente pode detalhar ESSE item direto (sem buscar).
    const itemId = question?.item_id;
    if (itemId) {
      try {
        const item = await this.httpClient.get(
          channel,
          `/items/${itemId}?attributes=id,title,permalink,thumbnail`,
        );
        const title = item?.title || String(itemId);
        const permalink = item?.permalink || '';
        (message.content as any).mlItem = {
          id: String(itemId),
          title,
          permalink,
          thumbnail: item?.thumbnail || null,
        };
        message.content.text =
          `${message.content.text}\n\n── Sobre o anúncio desta pergunta ──\n` +
          `${title}\nID: ${itemId}` +
          (permalink ? `\n${permalink}` : '');
      } catch (e: any) {
        this.logger.warn(`Falha ao enriquecer anúncio ${itemId}: ${e.message}`);
      }
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
    this.logger.log(`Pergunta ${questionId} → inbox (canal ${channelId})`);
  }
}
