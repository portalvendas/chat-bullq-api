import { Injectable } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import {
  NormalizedInboundMessage,
  NormalizedOutboundMessage,
  MessageContentType,
  StatusUpdate,
} from '../../ports/types';

/**
 * Mapeia payloads do Z-API <-> formato normalizado interno.
 * MVP (Fase 1): apenas TEXTO. Mídia/localização/reação → Fase 2.
 */
@Injectable()
export class ZApiMessageMapper {
  /** Webhook `ReceivedCallback` → mensagem normalizada (só texto no MVP). */
  normalizeInbound(event: any): NormalizedInboundMessage | null {
    if (!event || event.type !== 'ReceivedCallback') return null;

    const text: string | undefined = event.text?.message;
    if (typeof text !== 'string' || text.length === 0) {
      // MVP texto: ignora mídia e outros tipos por ora.
      return null;
    }

    const isGroup = event.isGroup === true;
    const isEcho = event.fromMe === true;

    // ── Dedup por LID ──────────────────────────────────────────────
    // O WhatsApp esconde o número do cliente atrás de um LID. No Z-API:
    //   - inbound do cliente: phone = número real  + chatLid = LID
    //   - echo/broadcast:     phone = <LID>@lid    + chatLid = LID
    // O `chatLid` é o ÚNICO id estável nos dois sentidos, então é ele a
    // chave do contato (senão inbound e outbound viram contatos/cards
    // separados). Grupo continua chaveado pelo id do grupo (phone).
    const rawPhone = String(event.phone ?? '');
    const phoneIsLid = /@lid$/i.test(rawPhone);
    const phoneDigits = rawPhone.replace(/\D/g, '');
    const lidDigits = event.chatLid
      ? String(event.chatLid).replace(/\D/g, '')
      : '';

    const externalContactId = isGroup ? phoneDigits : lidDigits || phoneDigits;
    if (!externalContactId) return null;

    // Número real só quando o phone NÃO é um LID (mensagem do cliente).
    const realPhone = !isGroup && !phoneIsLid ? phoneDigits : undefined;
    const looksLikeLid = (s: unknown) => !!s && /@lid$/i.test(String(s));

    return {
      externalMessageId: String(event.messageId ?? ''),
      externalContactId,
      // Nunca nomeia o contato com um LID. Em eco (fromMe) o remetente
      // somos nós → não sobrescreve o nome (undefined preserva o existente).
      contactName: isGroup
        ? event.chatName
        : isEcho
          ? undefined
          : event.senderName ||
            (looksLikeLid(event.chatName) ? undefined : event.chatName),
      contactPhone: isGroup ? undefined : realPhone,
      contactAvatarUrl: event.senderPhoto || event.photo || undefined,
      channelType: ChannelType.WHATSAPP_ZAPI,
      timestamp: event.momment ? new Date(Number(event.momment)) : new Date(),
      type: MessageContentType.TEXT,
      content: { text },
      isGroup,
      isEcho,
      senderName: event.senderName,
      rawPayload: event,
    };
  }

  /** Webhooks `DeliveryCallback` / `MessageStatusCallback` → StatusUpdate. */
  normalizeStatus(event: any): StatusUpdate | null {
    if (!event) return null;
    const ts = event.momment ? new Date(Number(event.momment)) : new Date();

    if (event.type === 'DeliveryCallback') {
      return {
        externalMessageId: String(event.messageId ?? ''),
        status: event.error ? 'failed' : 'delivered',
        timestamp: ts,
        errorMessage: event.error ? String(event.error) : undefined,
      };
    }

    if (event.type === 'MessageStatusCallback') {
      const id = Array.isArray(event.ids) ? event.ids[0] : event.messageId;
      return {
        externalMessageId: String(id ?? ''),
        status: this.mapStatus(event.status),
        timestamp: ts,
      };
    }

    return null;
  }

  private mapStatus(s: string): StatusUpdate['status'] {
    switch (String(s || '').toUpperCase()) {
      case 'SENT':
        return 'sent';
      case 'RECEIVED':
        return 'delivered';
      case 'READ':
      case 'READ_BY_ME':
      case 'PLAYED':
        return 'read';
      default:
        return 'sent';
    }
  }

  /** Mensagem normalizada de saída → endpoint + payload do Z-API. */
  denormalize(
    message: NormalizedOutboundMessage,
    contactExternalId: string,
  ): { endpoint: string; payload: Record<string, any> } {
    const phone = contactExternalId.replace(/\D/g, '');
    switch (message.type) {
      case MessageContentType.TEXT:
      default:
        return {
          endpoint: '/send-text',
          payload: { phone, message: message.content.text ?? '' },
        };
    }
  }
}
