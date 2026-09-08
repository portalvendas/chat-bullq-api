import { Injectable } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import {
  NormalizedInboundMessage,
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
    if (!text) return null; // MVP: só texto

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
      type: MessageContentType.TEXT,
      content: { text },
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
}
