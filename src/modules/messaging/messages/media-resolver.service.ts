import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import axios from 'axios';
import { PrismaService } from '../../../database/prisma.service';
import { ChannelAdapterRegistry } from '../../channel-hub/channel-adapter.registry';
import { UploadsService } from './uploads.service';

/**
 * Resolves a playable URL for an inbound media message.
 *
 * WhatsApp delivers media as encrypted .enc CDN URLs that browsers can't play.
 * The provider adapter knows how to decrypt and hand us a playable URL; we
 * cache it on `message.content.mediaUrl` so each message hits the provider
 * at most once. (If the cached URL eventually expires the client will get a
 * 404 on playback and we can re-resolve then — not worth the complexity yet.)
 */
@Injectable()
export class MediaResolverService {
  private readonly logger = new Logger(MediaResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapterRegistry: ChannelAdapterRegistry,
    private readonly uploads: UploadsService,
  ) {}

  async resolve(
    messageId: string,
    organizationId: string,
    access: import('../../iam/channel-access/channel-access.service').ChannelAccess = 'ALL',
  ): Promise<{ url: string; mimeType?: string }> {
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { conversation: { include: { channel: true } } },
    });
    if (!message) throw new NotFoundException('Message not found');
    if (message.conversation.organizationId !== organizationId) {
      throw new NotFoundException('Message not found');
    }
    if (
      access !== 'ALL' &&
      !access.has(message.conversation.channelId)
    ) {
      throw new NotFoundException('Message not found');
    }

    const content = (message.content ?? {}) as Record<string, any>;
    const channel = message.conversation.channel;
    const cached =
      typeof content.mediaUrl === 'string' ? content.mediaUrl : '';

    // Já durável (re-hospedada por nós) → serve direto.
    if (cached && cached.includes('/api/v1/uploads/')) {
      return { url: cached, mimeType: content.mimeType };
    }

    // URL externa/temporária (ex.: Backblaze `temp-file-download` do Z-API, que
    // expira em horas). Tenta re-hospedar agora: se ainda estiver viva, vira
    // durável e para de quebrar no histórico. Best-effort — se já expirou ou
    // falhar, devolve a própria URL como último recurso.
    if (cached && /^https?:\/\//i.test(cached)) {
      const rehosted = await this.tryRehostExternal(
        messageId,
        message.conversation.channelId,
        cached,
        content,
      );
      return rehosted ?? { url: cached, mimeType: content.mimeType };
    }

    // Sem URL nenhuma: usa o adapter do provider (resolve por id — ex.: Meta
    // Cloud, que guarda só o mediaId e busca a URL com Bearer).
    const externalId = message.externalId;
    if (!externalId) {
      throw new BadRequestException('Message has no external id to resolve');
    }

    const adapter = this.adapterRegistry.getOutbound(channel.type);
    if (!adapter.resolveInboundMediaUrl) {
      throw new BadRequestException(
        `Media resolution not implemented for ${channel.type}`,
      );
    }

    const { fileUrl, mimeType } = await adapter.resolveInboundMediaUrl(
      channel,
      {
        externalMessageId: externalId,
        mediaId: typeof content.mediaId === 'string' ? content.mediaId : undefined,
        mimeType: typeof content.mimeType === 'string' ? content.mimeType : undefined,
        originalFilename: typeof content.fileName === 'string' ? content.fileName : undefined,
      },
    );

    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        content: {
          ...content,
          mediaUrl: fileUrl,
          ...(mimeType && !content.mimeType ? { mimeType } : {}),
        } as any,
      },
    });

    return { url: fileUrl, mimeType: mimeType || content.mimeType };
  }

  /**
   * Baixa uma URL externa/temporária e re-hospeda no nosso storage durável,
   * atualizando `content.mediaUrl`. Best-effort: NUNCA lança — se a URL já
   * expirou (comum no Backblaze temp do Z-API) ou o storage falhar, devolve
   * null pro chamador cair no fallback.
   */
  private async tryRehostExternal(
    messageId: string,
    channelId: string,
    url: string,
    content: Record<string, any>,
  ): Promise<{ url: string; mimeType?: string } | null> {
    try {
      const resp = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: 60_000,
        maxContentLength: UploadsService.MAX_INBOUND_BYTES,
        maxBodyLength: UploadsService.MAX_INBOUND_BYTES,
      });
      const buffer = Buffer.from(resp.data);
      const mimeType =
        (typeof content.mimeType === 'string' && content.mimeType) ||
        (resp.headers?.['content-type'] as string) ||
        'application/octet-stream';
      const saved = await this.uploads.saveInboundMedia({
        buffer,
        mimeType,
        channelId,
        originalFilename:
          typeof content.fileName === 'string' ? content.fileName : null,
      });
      await this.prisma.message.update({
        where: { id: messageId },
        data: {
          content: {
            ...content,
            mediaUrl: saved.url,
            mimeType: saved.mimeType,
            fileSize: saved.size,
          } as any,
        },
      });
      this.logger.log(
        `Mídia externa re-hospedada sob demanda: msg=${messageId} -> ${saved.url}`,
      );
      return { url: saved.url, mimeType: saved.mimeType };
    } catch (err: any) {
      this.logger.warn(
        `Re-host sob demanda falhou (msg=${messageId}, url=${url}): ${err?.message ?? err}`,
      );
      return null;
    }
  }
}
