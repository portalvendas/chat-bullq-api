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
 * Decisão de modelagem: cada pergunta é uma "conversa" própria, com
 * externalContactId = question_id. Assim, ao responder no inbox, o
 * outbound recebe o question_id em `contactExternalId` e responde direto
 * via POST /answers — sem precisar carregar o id da pergunta por fora.
 */
@Injectable()
export class MercadoLivreMessageMapper {
  /** GET /questions/{id} → mensagem normalizada de entrada. */
  normalizeQuestion(q: any): NormalizedInboundMessage | null {
    if (!q?.id || typeof q.text !== 'string') return null;
    const questionId = String(q.id);
    const buyerId = q.from?.id ? String(q.from.id) : questionId;
    return {
      externalMessageId: questionId,
      externalContactId: questionId, // 1 pergunta = 1 conversa
      contactName: `Comprador ${buyerId}`,
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
