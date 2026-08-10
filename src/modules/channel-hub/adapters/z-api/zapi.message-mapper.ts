import { Injectable } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import {
  NormalizedInboundMessage,
  NormalizedMessageContent,
  NormalizedOutboundMessage,
  MessageContentType,
  StatusUpdate,
} from '../../ports/types';

/**
 * Mapeia payloads do Z-API <-> formato normalizado interno.
 * Suporta TEXTO e MÍDIA (imagem/vídeo/áudio/documento/figurinha). A URL de
 * mídia que o Z-API entrega é TEMPORÁRIA (Backblaze `temp-file-download`);
 * quem a torna durável é o pipeline (baixa + re-hospeda no nosso storage).
 */
@Injectable()
export class ZApiMessageMapper {
  /** Webhook `ReceivedCallback` → mensagem normalizada (texto ou mídia). */
  normalizeInbound(event: any): NormalizedInboundMessage | null {
    if (!event || event.type !== 'ReceivedCallback') return null;

    // Resolve tipo + conteúdo (texto OU mídia). Tipos não suportados
    // (localização, contato, enquete…) retornam null e são ignorados por ora.
    const parsed = this.resolveContent(event);
    if (!parsed) return null;

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
      type: parsed.type,
      content: parsed.content,
      // Reply/quote nativo do WhatsApp. No Z-API, o id da msg citada vem no
      // top-level `referenceMessageId` (≠ Cloud API, que usa `context.id`).
      // Guardamos só o id externo aqui; o pipeline resolve → nossa message e
      // enriquece com preview+remetente pra UI renderizar a quote box.
      replyTo: event.referenceMessageId
        ? { externalMessageId: String(event.referenceMessageId) }
        : undefined,
      isGroup,
      isEcho,
      senderName: event.senderName,
      rawPayload: event,
    };
  }

  /**
   * Extrai o tipo + conteúdo de um `ReceivedCallback`. Cada tipo de mídia vem
   * num objeto próprio no top-level com uma `*Url` (imageUrl, videoUrl…). A URL
   * é temporária — o pipeline re-hospeda depois. Retorna null para o que ainda
   * não suportamos (localização, contato, enquete), pra ignorar sem quebrar.
   *
   * @example entrada  { image: { imageUrl, mimeType, caption } }
   * @example saída    { type: 'IMAGE', content: { mediaUrl, mimeType, caption } }
   */
  private resolveContent(
    event: any,
  ): { type: MessageContentType; content: NormalizedMessageContent } | null {
    const text: string | undefined = event.text?.message;
    if (typeof text === 'string' && text.length > 0) {
      return { type: MessageContentType.TEXT, content: { text } };
    }

    if (event.image?.imageUrl) {
      return {
        type: MessageContentType.IMAGE,
        content: {
          mediaUrl: String(event.image.imageUrl),
          mimeType: event.image.mimeType || undefined,
          caption: event.image.caption || undefined,
        },
      };
    }

    if (event.video?.videoUrl) {
      return {
        type: MessageContentType.VIDEO,
        content: {
          mediaUrl: String(event.video.videoUrl),
          mimeType: event.video.mimeType || undefined,
          caption: event.video.caption || undefined,
        },
      };
    }

    if (event.audio?.audioUrl) {
      return {
        type: MessageContentType.AUDIO,
        content: {
          mediaUrl: String(event.audio.audioUrl),
          mimeType: event.audio.mimeType || undefined,
        },
      };
    }

    if (event.document?.documentUrl) {
      return {
        type: MessageContentType.DOCUMENT,
        content: {
          mediaUrl: String(event.document.documentUrl),
          mimeType: event.document.mimeType || undefined,
          fileName:
            event.document.fileName || event.document.title || undefined,
          caption: event.document.caption || undefined,
        },
      };
    }

    if (event.sticker?.stickerUrl) {
      return {
        type: MessageContentType.STICKER,
        content: {
          mediaUrl: String(event.sticker.stickerUrl),
          mimeType: event.sticker.mimeType || undefined,
        },
      };
    }

    return null;
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
    const c = (message.content ?? {}) as Record<string, any>;
    // Legenda: usa caption; no fallback aproveita o texto (nós às vezes
    // mandamos o texto do nó como legenda do anexo).
    const caption: string | undefined = c.caption ?? c.text ?? undefined;

    switch (message.type) {
      case MessageContentType.IMAGE:
        return {
          endpoint: '/send-image',
          payload: { phone, image: c.mediaUrl, caption },
        };

      case MessageContentType.VIDEO:
        return {
          endpoint: '/send-video',
          payload: { phone, video: c.mediaUrl, caption },
        };

      case MessageContentType.AUDIO:
        return {
          // Áudio comum (não PTT). Se precisar de "gravação de voz", trocar
          // por /send-ptt no futuro.
          endpoint: '/send-audio',
          payload: { phone, audio: c.mediaUrl },
        };

      case MessageContentType.DOCUMENT: {
        // Z-API exige a extensão no path: /send-document/{extension}.
        const fileName: string = c.fileName || 'arquivo';
        const ext =
          (fileName.split('.').pop() || '').toLowerCase().replace(/[^a-z0-9]/g, '') ||
          (typeof c.mimeType === 'string' && c.mimeType.includes('pdf')
            ? 'pdf'
            : 'bin');
        return {
          endpoint: `/send-document/${ext}`,
          payload: { phone, document: c.mediaUrl, fileName, caption },
        };
      }

      case MessageContentType.TEXT:
      default:
        return {
          endpoint: '/send-text',
          payload: { phone, message: c.text ?? '' },
        };
    }
  }
}
