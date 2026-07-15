import { Injectable } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import {
  NormalizedInboundMessage,
  MessageContentType,
} from '../../ports/types';

/**
 * Mapeia mensagens do Shopee Chat (sellerchat) <-> formato normalizado.
 * Fase 1: chat do comprador. Conversa chaveada por COMPRADOR (from_id) —
 * chat-style, 1 comprador = 1 conversa.
 *
 * NOTA: os nomes de campo do push/API do Shopee Chat precisam ser validados
 * contra o sandbox com uma loja conectada; aqui usamos os campos documentados
 * com fallbacks defensivos.
 */
@Injectable()
export class ShopeeMessageMapper {
  /** Extrai texto legível de uma mensagem do Shopee Chat conforme o tipo. */
  private extractText(msg: any): string {
    const type = msg?.message_type ?? msg?.type;
    const c = msg?.content ?? {};
    switch (type) {
      case 'text':
        return String(c.text ?? '');
      case 'image':
        return '[imagem]';
      case 'sticker':
        return '[sticker]';
      case 'item':
        return `[produto ${c.item_id ?? ''}]`.trim();
      case 'order':
        return `[pedido ${c.order_sn ?? c.ordersn ?? ''}]`.trim();
      default:
        return String(c.text ?? `[${type ?? 'mensagem'}]`);
    }
  }

  /**
   * Normaliza uma mensagem do Chat do Shopee (vinda do push ou de get_message).
   * `sellerUserId` é o id do vendedor na conversa — usado pra ignorar eco das
   * mensagens que NÓS enviamos (from_id === vendedor).
   */
  normalizeChatMessage(
    msg: any,
    sellerUserId?: string | number,
  ): NormalizedInboundMessage | null {
    const messageId = String(msg?.message_id ?? msg?.msg_id ?? '');
    const fromId = msg?.from_id ?? msg?.from_user_id;
    if (!messageId || fromId == null) return null;

    // Eco: mensagem enviada pelo próprio vendedor não vira inbound.
    if (sellerUserId != null && String(fromId) === String(sellerUserId)) {
      return null;
    }

    const tsRaw = msg?.created_timestamp ?? msg?.create_time ?? msg?.timestamp;
    const timestamp = tsRaw
      ? new Date(Number(tsRaw) * (String(tsRaw).length > 12 ? 1 : 1000))
      : new Date();

    return {
      externalMessageId: messageId,
      externalContactId: String(fromId), // comprador → 1 conversa
      contactName: `Comprador ${fromId}`,
      channelType: ChannelType.SHOPEE,
      timestamp,
      type: MessageContentType.TEXT,
      content: {
        text: this.extractText(msg),
      },
      isEcho: false,
      rawPayload: msg,
    };
  }

  /** Payload do POST /api/v2/sellerchat/send_message (resposta de texto). */
  denormalizeSend(
    toId: string | number,
    text: string,
  ): { to_id: number; message_type: 'text'; content: { text: string } } {
    return {
      to_id: Number(toId),
      message_type: 'text',
      content: { text: (text ?? '').slice(0, 3000) },
    };
  }
}
