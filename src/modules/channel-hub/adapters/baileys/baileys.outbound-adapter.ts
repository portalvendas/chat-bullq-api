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
    if (message.type !== MessageContentType.TEXT) {
      // MVP: só texto. Mídia é TODO (sock.sendMessage com image/document).
      throw new Error(
        `Baileys MVP só envia texto (recebido ${message.type})`,
      );
    }
    const text = message.content?.text ?? '';
    if (!text) throw new Error('Mensagem de texto vazia');

    const target = this.resolveSendTarget(contactExternalId);
    const res = await this.manager.sendText(channel.id, target, text);
    return { externalId: res.id, providerResponse: res };
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
