import { Injectable } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import {
  NormalizedInboundMessage,
  NormalizedMessageContent,
  MessageContentType,
} from '../../ports/types';

/**
 * Traduz eventos do socket Baileys (`messages.upsert`) para o
 * `NormalizedInboundMessage` do channel-hub, e o texto de saída para o
 * payload do `sock.sendMessage`.
 *
 * MVP: apenas TEXTO (conversation / extendedTextMessage). Mídia é TODO
 * (baixar via `downloadMediaMessage`, subir pro storage e preencher mediaUrl).
 *
 * Convenção de `externalContactId`: usamos o JID completo
 * `<numero>@s.whatsapp.net`, idêntico ao Zappfy/Z-API — assim o mesmo contato
 * dedupa entre provedores.
 */
@Injectable()
export class BaileysMessageMapper {
  /** `5511999998888@s.whatsapp.net` -> `5511999998888`. */
  jidToNumber(jid: string | undefined | null): string {
    if (!jid) return '';
    return String(jid).replace(/[:@].*$/, '').replace(/\D/g, '');
  }

  /** `5511999998888` -> `5511999998888@s.whatsapp.net`. */
  numberToJid(number: string): string {
    const digits = String(number).replace(/\D/g, '');
    return `${digits}@s.whatsapp.net`;
  }

  /**
   * Normaliza uma mensagem crua do Baileys. Retorna `null` quando não é um
   * evento que devemos ingerir (grupo, status broadcast, tipo não suportado,
   * mensagem vazia).
   */
  normalizeInbound(waMsg: any): NormalizedInboundMessage | null {
    const key = waMsg?.key;
    const message = waMsg?.message;
    if (!key || !message) return null;

    const remoteJid: string = key.remoteJid || '';
    // Ignora grupos, status@broadcast, newsletter e broadcast lists no MVP.
    if (
      !remoteJid ||
      remoteJid === 'status@broadcast' ||
      remoteJid.endsWith('@g.us') ||
      remoteJid.endsWith('@broadcast') ||
      remoteJid.endsWith('@newsletter')
    ) {
      return null;
    }

    const text = this.extractText(message);
    const media = text ? null : this.extractMedia(message);
    if (!text && !media) return null; // aceita texto OU mídia

    const isEcho = key.fromMe === true;
    // Baileys v7 usa LID (@lid) pra esconder o número: o `remoteJid` pode ser um
    // LID e o telefone real vem em `remoteJidAlt`. Respondemos SEMPRE ao
    // `remoteJid` original (a sessão que o socket já tem chaves) e só gravamos
    // `contactPhone` quando conseguimos um JID de telefone de verdade — nunca
    // fabricamos um telefone a partir dos dígitos do LID.
    const altJid: string = key.remoteJidAlt || '';
    const phoneJid = remoteJid.endsWith('@s.whatsapp.net')
      ? remoteJid
      : altJid.endsWith('@s.whatsapp.net')
        ? altJid
        : '';
    const phoneDigits = phoneJid ? this.jidToNumber(phoneJid) : '';
    const tsRaw = waMsg.messageTimestamp;
    const tsMs = tsRaw ? Number(tsRaw) * 1000 : Date.now();

    const result: NormalizedInboundMessage = {
      externalMessageId: key.id || '',
      externalContactId: remoteJid,
      contactName: isEcho ? undefined : waMsg.pushName || undefined,
      contactPhone: phoneDigits || undefined,
      channelType: ChannelType.WHATSAPP_BAILEYS,
      timestamp: new Date(tsMs),
      type: media ? media.type : MessageContentType.TEXT,
      content: media ? media.content : { text },
      isForwarded:
        !!message?.extendedTextMessage?.contextInfo?.isForwarded ||
        !!message?.extendedTextMessage?.contextInfo?.forwardingScore,
      isGroup: false,
      isEcho,
      rawPayload: waMsg,
    };

    const stanzaId =
      message?.extendedTextMessage?.contextInfo?.stanzaId || undefined;
    if (stanzaId) {
      result.replyTo = { externalMessageId: stanzaId };
    }

    return result;
  }

  /** Extrai texto puro de `conversation` ou `extendedTextMessage`. */
  private extractText(message: any): string {
    if (typeof message?.conversation === 'string' && message.conversation) {
      return message.conversation;
    }
    const ext = message?.extendedTextMessage?.text;
    if (typeof ext === 'string' && ext) return ext;
    // ephemeral / viewOnce wrappers
    const inner =
      message?.ephemeralMessage?.message ||
      message?.viewOnceMessage?.message ||
      message?.viewOnceMessageV2?.message;
    if (inner) return this.extractText(inner);
    return '';
  }

  /**
   * Extrai metadados de mídia (imagem/vídeo/áudio/documento/sticker). NÃO baixa
   * os bytes — o download+upload é feito no manager, que tem o socket. Aqui só
   * devolvemos type + content (caption/mimeType/fileName); o `mediaUrl` é
   * preenchido depois.
   */
  extractMedia(
    message: any,
  ): { type: MessageContentType; content: NormalizedMessageContent } | null {
    const inner =
      message?.ephemeralMessage?.message ||
      message?.viewOnceMessage?.message ||
      message?.viewOnceMessageV2?.message;
    if (inner) return this.extractMedia(inner);

    const img = message?.imageMessage;
    if (img)
      return {
        type: MessageContentType.IMAGE,
        content: {
          caption: img.caption || undefined,
          mimeType: img.mimetype || undefined,
        },
      };
    const vid = message?.videoMessage;
    if (vid)
      return {
        type: MessageContentType.VIDEO,
        content: {
          caption: vid.caption || undefined,
          mimeType: vid.mimetype || undefined,
        },
      };
    const aud = message?.audioMessage;
    if (aud)
      return {
        type: MessageContentType.AUDIO,
        content: { mimeType: aud.mimetype || undefined },
      };
    const doc =
      message?.documentMessage ||
      message?.documentWithCaptionMessage?.message?.documentMessage;
    if (doc)
      return {
        type: MessageContentType.DOCUMENT,
        content: {
          fileName: doc.fileName || undefined,
          caption: doc.caption || undefined,
          mimeType: doc.mimetype || undefined,
        },
      };
    const stk = message?.stickerMessage;
    if (stk)
      return {
        type: MessageContentType.STICKER,
        content: { mimeType: stk.mimetype || 'image/webp' },
      };
    return null;
  }

  /** True para tipos que carregam mídia (precisam baixar bytes no manager). */
  isMedia(type: MessageContentType): boolean {
    return (
      type === MessageContentType.IMAGE ||
      type === MessageContentType.VIDEO ||
      type === MessageContentType.AUDIO ||
      type === MessageContentType.DOCUMENT ||
      type === MessageContentType.STICKER
    );
  }
}
