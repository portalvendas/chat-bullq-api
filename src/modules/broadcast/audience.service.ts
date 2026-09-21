import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface AudienceFilter {
  pipelineId?: string;
  stageId?: string;
  tagIds?: string[];
  tagMatch?: 'ANY' | 'ALL';
  /** default true — nunca inclui quem deu opt-out, a menos que explicitamente false. */
  excludeOptedOut?: boolean;
}

export interface AudienceContact {
  id: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  metadata: Prisma.JsonValue;
}

/**
 * Resolve a audiência de um disparo por funil/etapa/tags. SEMPRE exige telefone
 * e (por padrão) suprime opt-out. Cursor estável por `contact.id asc`.
 */
@Injectable()
export class BroadcastAudienceService {
  constructor(private readonly prisma: PrismaService) {}

  /** Monta o WHERE do Prisma. Guardrail: filtro sem nenhum seletor → 400. */
  buildWhere(
    organizationId: string,
    filter: AudienceFilter,
  ): Prisma.ContactWhereInput {
    const tagIds = (filter.tagIds ?? []).filter(Boolean);
    const hasSelector = !!(filter.pipelineId || filter.stageId || tagIds.length);
    if (!hasSelector) {
      throw new BadRequestException(
        'Selecione ao menos um funil, etapa ou tag para a audiência.',
      );
    }

    const and: Prisma.ContactWhereInput[] = [
      { organizationId },
      { deletedAt: null },
      { phone: { not: null } },
      { phone: { not: '' } },
    ];

    if (filter.excludeOptedOut !== false) {
      and.push({ broadcastOptedOutAt: null });
    }

    // Funil/etapa via cards do contato.
    if (filter.pipelineId || filter.stageId) {
      and.push({
        cards: {
          some: {
            ...(filter.pipelineId ? { pipelineId: filter.pipelineId } : {}),
            ...(filter.stageId ? { stageId: filter.stageId } : {}),
          },
        },
      });
    }

    // Tags: ANY = tem qualquer uma; ALL = tem todas.
    if (tagIds.length) {
      if ((filter.tagMatch ?? 'ANY') === 'ALL') {
        for (const tagId of tagIds) {
          and.push({ tags: { some: { tagId } } });
        }
      } else {
        and.push({ tags: { some: { tagId: { in: tagIds } } } });
      }
    }

    return { AND: and };
  }

  /** COUNT server-side (estimativa de destinatários). */
  async count(organizationId: string, filter: AudienceFilter): Promise<number> {
    return this.prisma.contact.count({
      where: this.buildWhere(organizationId, filter),
    });
  }

  /**
   * Materializa uma página de contatos (para o disparo). Paginação por cursor
   * estável (`id asc`) — segura para varrer 100k+ sem pular/duplicar.
   */
  async page(
    organizationId: string,
    filter: AudienceFilter,
    opts: { cursor?: string; limit?: number } = {},
  ): Promise<{ items: AudienceContact[]; nextCursor: string | null }> {
    const take = Math.min(Math.max(opts.limit ?? 500, 1), 2000);
    const rows = await this.prisma.contact.findMany({
      where: this.buildWhere(organizationId, filter),
      select: { id: true, name: true, phone: true, email: true, metadata: true },
      orderBy: { id: 'asc' },
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > take;
    const items = hasMore ? rows.slice(0, take) : rows;
    return {
      items,
      nextCursor: hasMore ? items[items.length - 1].id : null,
    };
  }
}
