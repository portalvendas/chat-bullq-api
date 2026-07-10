import {
  Controller,
  Post,
  Body,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ChannelType } from '@prisma/client';
import { Public } from '../../../../common/decorators';
import { PrismaService } from '../../../../database/prisma.service';

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
    @InjectQueue('mercadolivre-inbound') private readonly queue: Queue,
  ) {}

  @Post('webhook')
  @Public()
  @HttpCode(200)
  @ApiOperation({ summary: 'Recebe notificações do Mercado Livre' })
  async handle(@Body() body: any): Promise<{ status: string }> {
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
          await this.queue.add(
            'ml-notification',
            {
              channelId: channel.id,
              organizationId: channel.organizationId,
              resource,
              topic,
            },
            {
              attempts: 5,
              backoff: { type: 'exponential', delay: 2000 },
              removeOnComplete: true,
              removeOnFail: false,
            },
          );
        } else {
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
