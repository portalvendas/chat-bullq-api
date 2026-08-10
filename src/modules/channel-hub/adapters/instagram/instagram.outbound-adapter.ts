import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, Channel } from '@prisma/client';
import { OutboundChannelPort } from '../../ports/outbound-channel.port';
import { NormalizedOutboundMessage, SendResult, RateLimitConfig } from '../../ports/types';
import { InstagramMessageMapper } from './instagram.message-mapper';
import { InstagramHttpClient } from './instagram.http-client';

@Injectable()
export class InstagramOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.INSTAGRAM;
  private readonly logger = new Logger(InstagramOutboundAdapter.name);

  constructor(
    private readonly mapper: InstagramMessageMapper,
    private readonly httpClient: InstagramHttpClient,
  ) {}

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    const payload = this.mapper.denormalize(message, contactExternalId);

    try {
      const response = await this.httpClient.sendMessage(channel, payload);
      return {
        externalId: response?.message_id || '',
        providerResponse: response,
      };
    } catch (err: any) {
      // Fora da janela padrão de 24h (cliente falou por último há >24h), a Meta
      // recusa com [#10] subcode 2534022 "outside of allowed window". Nesse
      // caso — e SÓ nesse — reenviamos como HUMAN_AGENT: a tag estende a janela
      // pra 7 dias quando é um ATENDENTE respondendo. Vale pra texto e mídia.
      //
      // Requer a feature "Human Agent" aprovada no app da Meta; sem ela, o
      // retry falha de novo (permissão/janela) e o erro sobe como antes —
      // sem regressão. Só re-tenta 1x, pra não entrar em loop.
      if (!this.isOutsideWindowError(err)) throw err;

      this.logger.warn(
        `IG fora da janela de 24h — reenviando como HUMAN_AGENT (janela de 7 dias): ${err?.message ?? err}`,
      );
      const taggedPayload = {
        ...payload,
        messaging_type: 'MESSAGE_TAG',
        tag: 'HUMAN_AGENT',
      };
      const response = await this.httpClient.sendMessage(channel, taggedPayload);
      return {
        externalId: response?.message_id || '',
        providerResponse: response,
      };
    }
  }

  /**
   * Detecta o erro de "fora da janela de mensagens" do Instagram/Meta.
   * O http-client embrulha o erro da Graph API numa Error cujo `message`
   * carrega o código/subcódigo, ex.:
   *   "Meta Graph API: [#10] This message is sent outside of allowed window. (subcode 2534022)"
   */
  private isOutsideWindowError(err: any): boolean {
    const msg = String(err?.message ?? '');
    return (
      msg.includes('2534022') ||
      /outside of allowed window/i.test(msg)
    );
  }

  async sendTypingIndicator(
    channel: Channel,
    contactExternalId: string,
  ): Promise<void> {
    try {
      await this.httpClient.sendMessage(channel, {
        recipient: { id: contactExternalId },
        sender_action: 'typing_on',
      });
    } catch (error: any) {
      this.logger.warn(`IG typing indicator failed: ${error.message}`);
    }
  }

  async getMediaUrl(_channel: Channel, mediaId: string): Promise<string> {
    return mediaId;
  }

  async downloadMedia(_channel: Channel, mediaUrl: string): Promise<Buffer> {
    return this.httpClient.downloadMedia(mediaUrl);
  }

  /**
   * Tenta o "unsend" via Graph API: `DELETE /{message-id}` em
   * graph.instagram.com. Meta historicamente não documenta esse endpoint
   * pra DM e, na maioria dos apps, retorna erro de permissão. Tentamos
   * mesmo assim — se funcionar, ótimo; se falhar, o service captura e
   * segue com soft-delete só no nosso lado.
   */
  async deleteMessage(
    channel: Channel,
    externalMessageId: string,
  ): Promise<void> {
    try {
      await this.httpClient.deleteMessage(channel, externalMessageId);
    } catch (err: any) {
      const metaCode = err?.response?.data?.error?.code;
      throw new Error(
        `Instagram unsend failed (id=${externalMessageId}, code=${metaCode ?? 'n/a'}): ` +
          `${err?.message ?? 'unknown'}. ` +
          'Marcamos como deletada só no Chat BullQ — Meta não permite remover ' +
          'mensagens já entregues no Direct via API.',
      );
    }
  }

  getRateLimits(): RateLimitConfig {
    return {
      maxPerSecond: 200,
      maxPerMinute: 5000,
      windowMs: 60000,
    };
  }
}
