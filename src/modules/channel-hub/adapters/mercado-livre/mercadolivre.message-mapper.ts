import { Injectable } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import {
  NormalizedInboundMessage,
  MessageContentType,
} from '../../ports/types';

/**
 * Mapeia recursos do Mercado Livre <-> formato normalizado interno.
 * Fase 1: PERGUNTAS (questions).
 *
 * Decisão de modelagem (v2 — agrupamento): a conversa é chaveada por
 * COMPRADOR + ANÚNCIO (`externalContactId = "{buyerId}:{itemId}"`). Assim,
 * várias perguntas do mesmo comprador no mesmo anúncio caem na MESMA
 * conversa — o agente vê o histórico e responde a 2ª pergunta já com o
 * contexto da 1ª. O `question_id` de cada pergunta continua em
 * `externalMessageId` (== message.externalId), e o outbound responde cada
 * pergunta em aberto por esse id (ver outbound-adapter). Fallback pro
 * `question_id` quando falta buyer/item (não agrupa, mas não quebra).
 */
@Injectable()
export class MercadoLivreMessageMapper {
  /** Monta a chave de conversa comprador+anúncio. Exposto pro outbound
   *  distinguir o modo agrupado do legado (1 pergunta = 1 conversa). */
  static buildContactKey(buyerId?: string | null, itemId?: string | null): string | null {
    if (buyerId && itemId) return `${buyerId}:${itemId}`;
    return null;
  }

  /** GET /questions/{id} → mensagem normalizada de entrada. */
  normalizeQuestion(q: any): NormalizedInboundMessage | null {
    if (!q?.id || typeof q.text !== 'string') return null;
    const questionId = String(q.id);
    const buyerId = q.from?.id ? String(q.from.id) : null;
    const itemId = q.item_id ? String(q.item_id) : null;
    const contactKey =
      MercadoLivreMessageMapper.buildContactKey(buyerId, itemId) ?? questionId;
    return {
      externalMessageId: questionId,
      externalContactId: contactKey, // comprador+anúncio (agrupa perguntas)
      contactName: `Comprador ${buyerId ?? questionId}`,
      channelType: ChannelType.MERCADO_LIVRE,
      timestamp: q.date_created ? new Date(q.date_created) : new Date(),
      type: MessageContentType.TEXT,
      content: {
        text: q.text,
      },
      isEcho: false,
      rawPayload: q,
    };
  }

  /** Resposta do inbox → payload do POST /answers. */
  denormalizeAnswer(
    contactExternalId: string,
    text: string,
  ): { question_id: number; text: string } {
    return {
      question_id: parseInt(contactExternalId, 10),
      text: (text ?? '').slice(0, 2000), // limite do ML
    };
  }
}
