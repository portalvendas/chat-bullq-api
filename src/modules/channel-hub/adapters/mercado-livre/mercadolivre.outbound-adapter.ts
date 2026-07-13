import { Injectable, Logger } from '@nestjs/common';
import {
  ChannelType,
  Channel,
  MessageDirection,
  MessageContentType,
} from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { OutboundChannelPort } from '../../ports/outbound-channel.port';
import {
  NormalizedOutboundMessage,
  SendResult,
  RateLimitConfig,
} from '../../ports/types';
import { MercadoLivreMessageMapper } from './mercadolivre.message-mapper';
import { MercadoLivreHttpClient } from './mercadolivre.http-client';

/**
 * Envio para o Mercado Livre — RESPONDER PERGUNTA(S).
 *
 * Dois modos, distinguidos pelo formato do `contactExternalId`:
 *
 *  1. AGRUPADO (novo, "{buyerId}:{itemId}"): a conversa junta várias
 *     perguntas do mesmo comprador no mesmo anúncio. Uma resposta do agente
 *     precisa fechar TODAS as perguntas ainda em aberto — o ML responde por
 *     `question_id`, então postamos a mesma resposta em cada pergunta não
 *     respondida da conversa (question_id vem de message.externalId) e
 *     marcamos `metadata.mlAnswered=true` pra não responder de novo.
 *
 *  2. LEGADO (question_id puro, sem ":"): conversas antigas (1 pergunta = 1
 *     conversa). Responde direto via POST /answers.
 */
@Injectable()
export class MercadoLivreOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.MERCADO_LIVRE;
  private readonly logger = new Logger(MercadoLivreOutboundAdapter.name);

  constructor(
    private readonly mapper: MercadoLivreMessageMapper,
    private readonly httpClient: MercadoLivreHttpClient,
    private readonly prisma: PrismaService,
  ) {}

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    const text = (message.content.text ?? '').slice(0, 2000);

    // ── Modo LEGADO: contactExternalId é um question_id puro ──
    if (!contactExternalId.includes(':')) {
      const payload = this.mapper.denormalizeAnswer(contactExternalId, text);
      const response = await this.httpClient.post(channel, '/answers/', payload);
      return {
        externalId: `mla-${payload.question_id}`,
        providerResponse: response,
      };
    }

    // ── Modo AGRUPADO: responde cada pergunta em aberto do comprador+anúncio ──
    const contactChannel = await this.prisma.contactChannel.findFirst({
      where: { channelId: channel.id, externalId: contactExternalId },
      select: { contactId: true },
    });
    if (!contactChannel) {
      this.logger.warn(
        `ML outbound: contactChannel não encontrado p/ ${contactExternalId} (canal ${channel.id})`,
      );
      return { externalId: `mla-noop-${Date.now()}`, providerResponse: null };
    }

    const conversation = await this.prisma.conversation.findFirst({
      where: {
        channelId: channel.id,
        contactId: contactChannel.contactId,
        deletedAt: null,
      },
      orderBy: { lastMessageAt: 'desc' },
      select: { id: true },
    });
    if (!conversation) {
      this.logger.warn(
        `ML outbound: conversa não encontrada p/ contato ${contactChannel.contactId}`,
      );
      return { externalId: `mla-noop-${Date.now()}`, providerResponse: null };
    }

    // Perguntas em aberto = mensagens INBOUND de texto com question_id
    // (externalId) que ainda não marcamos como respondidas.
    const inbound = await this.prisma.message.findMany({
      where: {
        conversationId: conversation.id,
        direction: MessageDirection.INBOUND,
        type: MessageContentType.TEXT,
        externalId: { not: null },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, externalId: true, metadata: true },
    });
    const pending = inbound.filter(
      (m) => !(m.metadata as Record<string, unknown> | null)?.['mlAnswered'],
    );

    if (pending.length === 0) {
      this.logger.warn(
        `ML outbound: sem perguntas em aberto na conversa ${conversation.id}`,
      );
      return {
        externalId: `mla-noop-${conversation.id}`,
        providerResponse: null,
      };
    }

    const answered: number[] = [];
    for (const m of pending) {
      const qid = parseInt(String(m.externalId), 10);
      if (Number.isNaN(qid)) continue;
      try {
        await this.httpClient.post(channel, '/answers/', {
          question_id: qid,
          text,
        });
        answered.push(qid);
        await this.prisma.message.update({
          where: { id: m.id },
          data: {
            metadata: {
              ...((m.metadata as Record<string, unknown> | null) ?? {}),
              mlAnswered: true,
              mlAnsweredAt: new Date().toISOString(),
            },
          },
        });
      } catch (err: any) {
        // ML devolve erro se a pergunta já foi respondida — não fatal.
        this.logger.error(
          `ML outbound: falha ao responder question ${qid} (conv ${conversation.id}): ${err?.message ?? err}`,
        );
      }
    }

    if (answered.length === 0) {
      throw new Error(
        `Nenhuma pergunta respondida no ML (conv ${conversation.id})`,
      );
    }

    this.logger.log(
      `ML outbound: respondidas ${answered.length} pergunta(s) [${answered.join(', ')}] na conversa ${conversation.id}`,
    );
    return {
      externalId: `mla-${answered.join('-')}`,
      providerResponse: { answered },
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
