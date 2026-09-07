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
   * Contato é chaveado pelo JID; o envio precisa do número real. Resolve pelo
   * contato e cai no próprio externalId como último recurso (idêntico ao Z-API).
   */
  private async resolveSendPhone(
    channelId: string,
    externalId: string,
  ): Promise<string> {
    try {
      const cc = await this.prisma.contactChannel.findUnique({
        where: { uq_contact_channel_external: { channelId, externalId } },
        include: { contact: { select: { phone: true } } },
      });
      const phone = cc?.contact?.phone?.replace(/\D/g, '');
      if (phone) return phone;
    } catch (err: any) {
      this.logger.warn(`resolveSendPhone falhou (${externalId}): ${err?.message}`);
    }
    return externalId.replace(/\D/g, '');
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

    const sendPhone = await this.resolveSendPhone(channel.id, contactExternalId);
    const res = await this.manager.sendText(channel.id, sendPhone, text);
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
