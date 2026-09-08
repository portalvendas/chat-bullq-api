import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, Channel } from '@prisma/client';
import { OutboundChannelPort } from '../../ports/outbound-channel.port';
import {
  NormalizedOutboundMessage,
  SendResult,
  RateLimitConfig,
  MessageContentType,
} from '../../ports/types';
import { PrismaService } from '../../../../database/prisma.service';
import { BaileysSessionManager } from './baileys-session.manager';
import { BaileysMessageMapper } from './baileys.message-mapper';

@Injectable()
export class BaileysOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_BAILEYS;
  private readonly logger = new Logger(BaileysOutboundAdapter.name);

  constructor(
    private readonly manager: BaileysSessionManager,
    private readonly mapper: BaileysMessageMapper,
    private readonly prisma: PrismaService,
  ) {}

  /**
   * O contato é chaveado pelo JID COMPLETO do WhatsApp — telefone
   * (`<num>@s.whatsapp.net`) OU LID (`<id>@lid`). Respondemos ao JID EXATO da
   * conversa: é a sessão que o Baileys já tem chaves, então entrega de fato.
   * (No LID, reconstruir um `@s.whatsapp.net` a partir dos dígitos gera um
   * número inexistente — a msg fica com 1 tique e nunca chega.) Só
   * reconstruímos quando, por algum motivo, vier apenas o número solto.
   */
  private resolveSendTarget(externalId: string): string {
    if (externalId.includes('@')) return externalId;
    return this.mapper.numberToJid(externalId);
  }

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    const target = this.resolveSendTarget(contactExternalId);
    const content = this.buildContent(message);
    const res = await this.manager.sendContent(channel.id, target, content);
    return { externalId: res.id, providerResponse: res };
  }

  /**
   * Monta o payload do `sock.sendMessage` do Baileys a partir da mensagem
   * normalizada. Mídia vai por URL (`{ url }`): o Baileys baixa a `mediaUrl`
   * (mesma URL pública que os outros provedores consomem) e faz o upload
   * cifrado pro WhatsApp. `caption` cai no texto do nó quando não há legenda.
   */
  private buildContent(message: NormalizedOutboundMessage): any {
    const c = (message.content ?? {}) as any;
    const caption: string | undefined = c.caption ?? c.text ?? undefined;
    switch (message.type) {
      case MessageContentType.TEXT: {
        const text = c.text ?? '';
        if (!text) throw new Error('Mensagem de texto vazia');
        return { text };
      }
      case MessageContentType.IMAGE:
        if (!c.mediaUrl) throw new Error('IMAGE sem mediaUrl');
        return { image: { url: c.mediaUrl }, caption, mimetype: c.mimeType || undefined };
      case MessageContentType.VIDEO:
        if (!c.mediaUrl) throw new Error('VIDEO sem mediaUrl');
        return { video: { url: c.mediaUrl }, caption, mimetype: c.mimeType || undefined };
      case MessageContentType.AUDIO:
        if (!c.mediaUrl) throw new Error('AUDIO sem mediaUrl');
        return { audio: { url: c.mediaUrl }, mimetype: c.mimeType || 'audio/mpeg', ptt: false };
      case MessageContentType.DOCUMENT:
        if (!c.mediaUrl) throw new Error('DOCUMENT sem mediaUrl');
        return {
          document: { url: c.mediaUrl },
          fileName: c.fileName || 'arquivo',
          mimetype: c.mimeType || 'application/octet-stream',
          caption,
        };
      case MessageContentType.STICKER:
        if (!c.mediaUrl) throw new Error('STICKER sem mediaUrl');
        return { sticker: { url: c.mediaUrl } };
      default:
        throw new Error(`Baileys: tipo ${message.type} não suportado no envio`);
    }
  }

  async sendTypingIndicator(): Promise<void> {
    // Fase 2 (sock.sendPresenceUpdate('composing', jid)). No-op no MVP.
  }

  async getMediaUrl(_channel: Channel, mediaId: string): Promise<string> {
    return mediaId;
  }

  async downloadMedia(_channel: Channel, _mediaId: string): Promise<Buffer> {
    throw new Error('Baileys: download de mídia ainda não implementado');
  }

  getRateLimits(): RateLimitConfig {
    return { maxPerSecond: 1, maxPerMinute: 30, windowMs: 60000 };
  }
}
