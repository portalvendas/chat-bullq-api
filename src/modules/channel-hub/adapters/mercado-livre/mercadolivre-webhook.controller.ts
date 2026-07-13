import {
  Controller,
  Post,
  Body,
  Headers,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ChannelType } from '@prisma/client';
import { Public } from '../../../../common/decorators';
import { PrismaService } from '../../../../database/prisma.service';
import { WebhookEventsService } from '../../webhook-events.service';

/**
 * Webhook (notifications) do Mercado Livre — modelo 2 passos.
 * Responde 200 imediatamente e enfileira; o fetch do recurso é no processor.
 * Roteia o canal por `user_id` (== config.sellerId).
 */
@ApiTags('Webhooks')
@Controller('integrations/mercado-livre')
export class MercadoLivreWebhookController {
  private readonly logger = new Logger(MercadoLivreWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookEvents: WebhookEventsService,
    @InjectQueue('mercadolivre-inbound') private readonly queue: Queue,
  ) {}

  @Post('webhook')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Recebe notificações do Mercado Livre' })
  async handle(
    @Body() body: any,
    @Headers() headers: Record<string, string>,
  ): Promise<{ status: string }> {
    try {
      const topic = body?.topic;
      const resource = body?.resource;
      const userId = body?.user_id;
      if (topic && resource && userId != null) {
        const channel = await this.prisma.channel.findFirst({
          where: {
            type: ChannelType.MERCADO_LIVRE,
            isActive: true,
            config: { path: ['sellerId'], equals: String(userId) },
          },
        });
        if (channel) {
          // Grava o evento CRU antes de enfileirar — fonte de verdade pra
          // replay se o processamento falhar (paridade com canais genéricos).
          const webhookEventId = await this.webhookEvents.record(
            channel.id,
            ChannelType.MERCADO_LIVRE,
            body,
            headers ?? {},
          );
          await this.queue.add(
            'ml-notification',
            {
              channelId: channel.id,
              organizationId: channel.organizationId,
              resource,
              topic,
              webhookEventId,
            },
            {
              attempts: 5,
              backoff: { type: 'exponential', delay: 2000 },
              removeOnComplete: true,
              removeOnFail: false,
            },
          );
        } else {
          // Seller desconhecido — registra como UNROUTED pra auditoria/replay.
          await this.webhookEvents.recordUnrouted(
            ChannelType.MERCADO_LIVRE,
            body,
            headers ?? {},
          );
          this.logger.warn(`Notificação ML de seller desconhecido: ${userId}`);
        }
      }
    } catch (err: any) {
      // Nunca falhar a resposta — o ML reenvia se não receber 200.
      this.logger.error(`Erro ao processar notificação ML: ${err.message}`);
    }
    return { status: 'ok' };
  }
}
