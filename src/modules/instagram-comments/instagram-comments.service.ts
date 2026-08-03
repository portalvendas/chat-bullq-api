import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Channel } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { InstagramHttpClient } from '../channel-hub/adapters/instagram/instagram.http-client';
import { PipelinesService } from '../pipelines/pipelines.service';
import { NormalizedComment } from '../channel-hub/ports/types';

/** Texto padrão da auto-DM (private reply) a um comentário. Sobrescrevível
 *  por canal em `channel.config.commentAutoReplyText`. */
const DEFAULT_AUTOREPLY =
  'Oi! Vi seu comentário 💛 Te chamei aqui no direct pra te ajudar melhor. 😊';

interface ListQuery {
  cursor?: string;
  limit?: number;
  status?: string; // NEW | HANDLED
}

@Injectable()
export class InstagramCommentsService {
  private readonly logger = new Logger(InstagramCommentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: InstagramHttpClient,
    private readonly pipelines: PipelinesService,
  ) {}

  private autoReplyText(channel: Channel): string {
    const cfg = (channel.config ?? {}) as Record<string, any>;
    return (
      (typeof cfg.commentAutoReplyText === 'string' &&
        cfg.commentAutoReplyText.trim()) ||
      DEFAULT_AUTOREPLY
    );
  }

  /**
   * Ingesta de comentário (chamado pelo worker). Persiste o comentário FORA do
   * inbox, enriquece com os dados da mídia (post/anúncio) e dispara a auto-DM
   * privada. Idempotente por (channelId, externalCommentId). Best-effort nas
   * chamadas externas — nunca lança pra não travar a fila.
   */
  async ingest(
    organizationId: string,
    channelId: string,
    comment: NormalizedComment,
  ): Promise<void> {
    const channel = await this.prisma.channel.findUnique({
      where: { id: channelId },
    });
    if (!channel) return;

    // Enriquecimento da mídia (post/anúncio) — best-effort.
    let media: Record<string, any> | null = null;
    if (comment.mediaId) {
      try {
        media = await this.http.getMediaDetails(channel, comment.mediaId);
      } catch (err: any) {
        this.logger.warn(
          `getMediaDetails falhou (media=${comment.mediaId}): ${err?.message}`,
        );
      }
    }

    const data = {
      organizationId,
      channelId,
      externalCommentId: comment.externalCommentId,
      parentCommentId: comment.parentCommentId ?? null,
      fromExternalId: comment.fromExternalId,
      fromUsername: comment.fromUsername ?? null,
      text: comment.text ?? '',
      mediaId: comment.mediaId ?? null,
      adId: comment.adId ?? null,
      mediaCaption: media?.caption ?? null,
      mediaPermalink: media?.permalink ?? null,
      mediaUrl: media?.media_url ?? media?.thumbnail_url ?? null,
      mediaType: media?.media_type ?? null,
    };

    const saved = await this.prisma.instagramComment.upsert({
      where: {
        channelId_externalCommentId: {
          channelId,
          externalCommentId: comment.externalCommentId,
        },
      },
      update: {
        // Reenriquece a mídia se antes não tínhamos; não sobrescreve estado.
        mediaCaption: data.mediaCaption,
        mediaPermalink: data.mediaPermalink,
        mediaUrl: data.mediaUrl,
        mediaType: data.mediaType,
      },
      create: data,
    });

    // Auto-DM privada (uma vez). Só tenta se ainda não enviamos.
    if (!saved.dmSent) {
      try {
        await this.http.sendPrivateReply(
          channel,
          comment.externalCommentId,
          this.autoReplyText(channel),
        );
        await this.prisma.instagramComment.update({
          where: { id: saved.id },
          data: { dmSent: true },
        });
        this.logger.log(
          `Auto-DM enviada p/ comentário ${comment.externalCommentId}`,
        );
      } catch (err: any) {
        this.logger.warn(
          `Auto-DM (private reply) falhou p/ comentário ${comment.externalCommentId}: ${err?.message}`,
        );
      }
    }
  }

  /** Lista paginada (cursor por id desc) de comentários da org. */
  async list(organizationId: string, query: ListQuery) {
    const limit = Math.min(Math.max(Number(query.limit) || 30, 1), 100);
    const where: Record<string, any> = { organizationId };
    if (query.status) where.status = query.status;

    const rows = await this.prisma.instagramComment.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit + 1,
      ...(query.cursor
        ? { cursor: { id: query.cursor }, skip: 1 }
        : {}),
    });
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    return {
      data,
      nextCursor: hasMore ? data[data.length - 1].id : null,
    };
  }

  private async loadOwned(organizationId: string, id: string) {
    const comment = await this.prisma.instagramComment.findFirst({
      where: { id, organizationId },
    });
    if (!comment) throw new NotFoundException('Comentário não encontrado');
    const channel = await this.prisma.channel.findUnique({
      where: { id: comment.channelId },
    });
    if (!channel) throw new NotFoundException('Canal do comentário não existe');
    return { comment, channel };
  }

  /** Resposta PÚBLICA no post. */
  async replyPublic(organizationId: string, id: string, text: string) {
    const { comment, channel } = await this.loadOwned(organizationId, id);
    await this.http.replyToComment(channel, comment.externalCommentId, text);
    return this.prisma.instagramComment.update({
      where: { id },
      data: { repliedPublic: true, status: 'HANDLED' },
    });
  }

  /** DM privada (private reply) manual. */
  async replyDm(organizationId: string, id: string, text?: string) {
    const { comment, channel } = await this.loadOwned(organizationId, id);
    const body = (text && text.trim()) || this.autoReplyText(channel);
    await this.http.sendPrivateReply(channel, comment.externalCommentId, body);
    return this.prisma.instagramComment.update({
      where: { id },
      data: { dmSent: true },
    });
  }

  /** Converte o comentário em lead: cria/acha o contato e cria card na entrada. */
  async convertLead(organizationId: string, id: string) {
    const { comment } = await this.loadOwned(organizationId, id);

    // Acha o contato por igUserId; senão cria um novo.
    let contact = await this.prisma.contact.findFirst({
      where: {
        organizationId,
        metadata: { path: ['igUserId'], equals: comment.fromExternalId },
      },
      select: { id: true },
    });
    if (!contact) {
      contact = await this.prisma.contact.create({
        data: {
          organizationId,
          name: comment.fromUsername ?? 'Instagram',
          metadata: {
            source: 'instagram_comment',
            igUserId: comment.fromExternalId,
          } as any,
        },
        select: { id: true },
      });
    }

    const card = await this.pipelines.createEntryCardForContact(
      organizationId,
      contact.id,
      comment.fromUsername
        ? `Comentário de @${comment.fromUsername}`
        : 'Comentário do Instagram',
      {
        source: 'instagram_comment',
        comment: {
          text: comment.text,
          permalink: comment.mediaPermalink,
          mediaId: comment.mediaId,
        },
      },
      { channelId: comment.channelId },
    );

    // Se já havia card aberto, createEntryCardForContact retorna null: usa o existente.
    let cardId = card?.id ?? null;
    if (!cardId) {
      const existing = await this.prisma.card.findFirst({
        where: { organizationId, contactId: contact.id, status: 'OPEN' },
        select: { id: true },
      });
      cardId = existing?.id ?? null;
    }

    return this.prisma.instagramComment.update({
      where: { id },
      data: {
        contactId: contact.id,
        convertedCardId: cardId,
        status: 'HANDLED',
      },
    });
  }
}
