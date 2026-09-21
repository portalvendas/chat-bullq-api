import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface AudienceFilter {
  pipelineId?: string;
  stageId?: string;
  tagIds?: string[];
  tagMatch?: 'ANY' | 'ALL';
  /** Só contatos com pedido no ERP (Tiny). */
  hasPedido?: boolean;
  /** Só contatos com orçamento no ERP (Tiny). */
  hasOrcamento?: boolean;
  /** Exclui quem TEM pedido (recuperação de carrinho: orçou e não comprou). */
  excludePedido?: boolean;
  /** Período (YYYY-MM-DD). Filtra a data do pedido/orçamento quando um dos
   *  filtros de ERP está ativo; senão, filtra a data de criação do lead. */
  from?: string;
  to?: string;
  /** default true — nunca inclui quem deu opt-out, a menos que explicitamente false. */
  excludeOptedOut?: boolean;
}

function startOfDay(d: string): Date {
  return new Date(`${d}T00:00:00`);
}
function endOfDay(d: string): Date {
  return new Date(`${d}T23:59:59.999`);
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
    const wantsPedido = !!filter.hasPedido;
    const wantsOrcamento = !!filter.hasOrcamento;
    const hasSelector = !!(
      filter.pipelineId ||
      filter.stageId ||
      tagIds.length ||
      wantsPedido ||
      wantsOrcamento
    );
    if (!hasSelector) {
      throw new BadRequestException(
        'Selecione ao menos um funil, etapa, tag, pedido ou orçamento.',
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

    // Período: aplicado à data do pedido/orçamento quando há filtro de ERP;
    // senão, à data de criação do lead.
    const docDate: Prisma.DateTimeNullableFilter = {};
    if (filter.from) docDate.gte = startOfDay(filter.from);
    if (filter.to) docDate.lte = endOfDay(filter.to);
    const hasPeriod = !!(filter.from || filter.to);

    if (wantsPedido) {
      and.push({
        tinyDocuments: {
          some: { kind: 'PEDIDO', ...(hasPeriod ? { data: docDate } : {}) },
        },
      });
    }
    if (wantsOrcamento) {
      and.push({
        tinyDocuments: {
          some: { kind: 'ORCAMENTO', ...(hasPeriod ? { data: docDate } : {}) },
        },
      });
    }
    // Recuperação de carrinho: exclui quem já tem QUALQUER pedido (sem período —
    // quem comprou uma vez não deve receber a recuperação).
    if (filter.excludePedido) {
      and.push({
        NOT: { tinyDocuments: { some: { kind: 'PEDIDO' } } },
      });
    }
    if (!wantsPedido && !wantsOrcamento && hasPeriod) {
      const created: Prisma.DateTimeFilter = {};
      if (filter.from) created.gte = startOfDay(filter.from);
      if (filter.to) created.lte = endOfDay(filter.to);
      and.push({ createdAt: created });
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

  /**
   * Prévia da audiência com contagem de pedidos/orçamentos por lead. Usado na
   * tela pra o operador VER quem vai receber (nome, telefone, nº de pedidos e
   * orçamentos, valor em pedidos). Paginação por cursor.
   */
  async previewLeads(
    organizationId: string,
    filter: AudienceFilter,
    opts: { cursor?: string; limit?: number } = {},
  ) {
    const take = Math.min(Math.max(opts.limit ?? 30, 1), 100);
    const rows = await this.prisma.contact.findMany({
      where: this.buildWhere(organizationId, filter),
      select: { id: true, name: true, phone: true },
      orderBy: { id: 'asc' },
      take: take + 1,
      ...(opts.cursor ? { cursor: { id: opts.cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    const ids = page.map((c) => c.id);

    // Agrega pedidos/orçamentos (contagem + valor) dos contatos da página.
    const agg = ids.length
      ? await this.prisma.tinyDocument.groupBy({
          by: ['contactId', 'kind'],
          where: { organizationId, contactId: { in: ids } },
          _count: { _all: true },
          _sum: { valor: true },
        })
      : [];
    const byContact = new Map<
      string,
      { pedidos: number; orcamentos: number; valorPedidos: number }
    >();
    for (const a of agg) {
      if (!a.contactId) continue;
      const e =
        byContact.get(a.contactId) ??
        { pedidos: 0, orcamentos: 0, valorPedidos: 0 };
      if (a.kind === 'PEDIDO') {
        e.pedidos = a._count._all;
        e.valorPedidos = Number(a._sum.valor ?? 0);
      } else if (a.kind === 'ORCAMENTO') {
        e.orcamentos = a._count._all;
      }
      byContact.set(a.contactId, e);
    }

    return {
      items: page.map((c) => ({
        id: c.id,
        name: c.name,
        phone: c.phone,
        pedidos: byContact.get(c.id)?.pedidos ?? 0,
        orcamentos: byContact.get(c.id)?.orcamentos ?? 0,
        valorPedidos: byContact.get(c.id)?.valorPedidos ?? 0,
      })),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }
}
