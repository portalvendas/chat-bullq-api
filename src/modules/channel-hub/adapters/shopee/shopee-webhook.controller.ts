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
 * Webhook (push) do Shopee — nível PARTNER (uma URL pra todas as lojas). O
 * body traz `shop_id` + `data`. Roteamos por shop_id, gravamos o evento cru e
 * enfileiramos as mensagens de chat pro processor. Responde 200 rápido.
 *
 * TODO(validação sandbox): verificar a assinatura do push (Authorization =
 * HMAC-SHA256(partner_key, `url|raw_body`)) — exige raw body middleware; por
 * ora roteamos por shop_id (Fase 1). Confirmar também o `code` do evento de
 * chat; aqui detectamos pela forma do `data`.
 */
@ApiTags('Webhooks')
@Controller('integrations/shopee')
export class ShopeeWebhookController {
  private readonly logger = new Logger(ShopeeWebhookController.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webhookEvents: WebhookEventsService,
    @InjectQueue('shopee-inbound') private readonly queue: Queue,
  ) {}

  @Post('webhook')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Recebe push do Shopee (chat)' })
  async handle(
    @Body() body: any,
    @Headers() headers: Record<string, string>,
  ): Promise<{ status: string }> {
    try {
      const shopId = body?.shop_id ?? body?.data?.shop_id;
      const data = body?.data ?? {};
      // Só nos interessa mensagem de chat (Fase 1). Detecta pela forma.
      const isChatMessage = !!(
        data?.message_id ||
        data?.msg_id ||
        data?.message_type ||
        data?.content
      );
      if (shopId != null && isChatMessage) {
        // Roteia por shop_id (filtro JSON no código — Prisma JSON path frágil).
        const channels = await this.prisma.channel.findMany({
          where: { type: ChannelType.SHOPEE, isActive: true, deletedAt: null },
        });
        const channel = channels.find(
          (c) =>
            String((c.config as Record<string, any>)?.shopId ?? '') ===
            String(shopId),
        );
        if (channel) {
          const webhookEventId = await this.webhookEvents.record(
            channel.id,
            ChannelType.SHOPEE,
            body,
            headers ?? {},
          );
          await this.queue.add(
            'shopee-message',
            {
              channelId: channel.id,
              organizationId: channel.organizationId,
              data,
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
          await this.webhookEvents.recordUnrouted(
            ChannelType.SHOPEE,
            body,
            headers ?? {},
          );
          this.logger.warn(`Push Shopee de shop desconhecido: ${shopId}`);
        }
      }
    } catch (err: any) {
      // Nunca falhar a resposta — Shopee reenfileira em não-200.
      this.logger.error(`Erro ao processar push Shopee: ${err.message}`);
    }
    return { status: 'ok' };
  }
}
