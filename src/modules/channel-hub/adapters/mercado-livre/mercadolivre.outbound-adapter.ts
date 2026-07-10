import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, Channel } from '@prisma/client';
import { OutboundChannelPort } from '../../ports/outbound-channel.port';
import {
  NormalizedOutboundMessage,
  SendResult,
  RateLimitConfig,
} from '../../ports/types';
import { MercadoLivreMessageMapper } from './mercadolivre.message-mapper';
import { MercadoLivreHttpClient } from './mercadolivre.http-client';

/**
 * Envio para o Mercado Livre — Fase 1: RESPONDER PERGUNTA.
 * `contactExternalId` carrega o question_id (ver message-mapper).
 * Responde via POST /answers/ { question_id, text }.
 */
@Injectable()
export class MercadoLivreOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.MERCADO_LIVRE;
  private readonly logger = new Logger(MercadoLivreOutboundAdapter.name);

  constructor(
    private readonly mapper: MercadoLivreMessageMapper,
    private readonly httpClient: MercadoLivreHttpClient,
  ) {}

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    const payload = this.mapper.denormalizeAnswer(
      contactExternalId,
      message.content.text ?? '',
    );
    const response = await this.httpClient.post(channel, '/answers/', payload);
    return {
      // /answers não devolve id de mensagem próprio; usamos o question_id
      // como âncora (não há webhook de eco que colida com isso).
      externalId: `mla-${payload.question_id}`,
      providerResponse: response,
    };
  }

  async sendTypingIndicator(): Promise<void> {
    // Não se aplica a perguntas do ML.
  }

  async getMediaUrl(_channel: Channel, mediaId: string): Promise<string> {
    return mediaId;
  }

  async downloadMedia(): Promise<Buffer> {
    throw new Error('Mercado Livre (perguntas) não suporta download de mídia');
  }

  getRateLimits(): RateLimitConfig {
    return { maxPerSecond: 2, maxPerMinute: 60, windowMs: 60000 };
  }
}
