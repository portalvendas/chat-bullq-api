import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import {
  KnowledgeItem,
  KnowledgeSource,
  KnowledgeStatus,
  KnowledgeType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

/** Tipos cujo texto vale recall semântico (RAG). VARIANT_MAP/AD_SPEC são
 *  melhor recuperados por escopo/injeção direta, não semântica. */
const RAG_INDEXABLE: KnowledgeType[] = [
  KnowledgeType.FACT,
  KnowledgeType.FAQ,
  KnowledgeType.POLICY,
];

export interface CreateKnowledgeInput {
  type?: KnowledgeType;
  status?: KnowledgeStatus;
  source?: KnowledgeSource;
  itemId?: string | null;
  title?: string | null;
  text: string;
  payload?: Prisma.InputJsonValue;
  sourceRef?: string | null;
  sourceQuestion?: string | null;
  createdById?: string | null;
}

/**
 * Central de Conhecimento — fonte da verdade única que alimenta as respostas
 * da IA. Toda fonte (complemento do operador, varredura de anúncios, import de
 * arquivo, nota manual) grava aqui com STATUS de validação. Só itens VALIDATED
 * influenciam as respostas.
 */
@Injectable()
export class KnowledgeService {
  private readonly logger = new Logger(KnowledgeService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('rag-indexer') private readonly ragQueue: Queue,
  ) {}

  /** Agentes ativos da org — o conhecimento é indexado por-agente (o retrieval
   *  já filtra por agentId, então isso garante isolamento por org). */
  private async orgAgentIds(organizationId: string): Promise<string[]> {
    const agents = await this.prisma.aiAgent.findMany({
      where: { organizationId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    return agents.map((a) => a.id);
  }

  /**
   * Cria vários itens de uma vez (import em massa — ex: FAQ migrada dos bots
   * do Kommo). Reusa `create` (que já indexa no RAG). Retorna quantos criou.
   */
  async bulkCreate(
    organizationId: string,
    items: CreateKnowledgeInput[],
  ): Promise<{ created: number }> {
    let created = 0;
    for (const it of items) {
      if (!it?.text || !it.text.trim()) continue;
      await this.create(organizationId, it);
      created++;
    }
    return { created };
  }

  /** Indexa um item VALIDADO (só tipos semânticos) no RAG, um por agente. */
  private async indexToRag(item: KnowledgeItem): Promise<void> {
    if (
      item.status !== KnowledgeStatus.VALIDATED ||
      !RAG_INDEXABLE.includes(item.type)
    ) {
      return;
    }
    try {
      const agentIds = await this.orgAgentIds(item.organizationId);
      for (const agentId of agentIds) {
        await this.ragQueue.add(
          'index_knowledge',
          {
            type: 'index_knowledge',
            knowledgeId: `${item.id}:${agentId}`,
            content: item.text,
            scope: { organizationId: item.organizationId, agentId, ownerType: 'knowledge' },
            metadata: { knowledgeItemId: item.id, organizationId: item.organizationId },
          },
          { removeOnComplete: 200, removeOnFail: 50 },
        );
      }
    } catch (err: any) {
      this.logger.warn(`indexToRag ${item.id} falhou: ${err?.message ?? err}`);
    }
  }

  /** Remove do RAG (todas as cópias por-agente). */
  private async deindexFromRag(
    organizationId: string,
    itemId: string,
  ): Promise<void> {
    try {
      const agentIds = await this.orgAgentIds(organizationId);
      for (const agentId of agentIds) {
        await this.ragQueue.add(
          'delete_entry',
          { type: 'delete_entry', id: `knowledge:${itemId}:${agentId}` },
          { removeOnComplete: 200, removeOnFail: 50 },
        );
      }
    } catch (err: any) {
      this.logger.warn(`deindexFromRag ${itemId} falhou: ${err?.message ?? err}`);
    }
  }

  async create(organizationId: string, input: CreateKnowledgeInput) {
    const created = await this.prisma.knowledgeItem.create({
      data: {
        organizationId,
        type: input.type ?? KnowledgeType.FACT,
        status: input.status ?? KnowledgeStatus.PENDING,
        source: input.source ?? KnowledgeSource.MANUAL,
        itemId: input.itemId ?? null,
        title: input.title ?? null,
        text: input.text.trim(),
        payload: input.payload ?? {},
        sourceRef: input.sourceRef ?? null,
        sourceQuestion: input.sourceQuestion ?? null,
        createdById: input.createdById ?? null,
      },
    });
    await this.indexToRag(created); // no-op se não for VALIDATED/semântico
    return created;
  }

  async list(
    organizationId: string,
    filters: {
      status?: KnowledgeStatus;
      itemId?: string;
      type?: KnowledgeType;
      search?: string;
    } = {},
  ) {
    return this.prisma.knowledgeItem.findMany({
      where: {
        organizationId,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.type ? { type: filters.type } : {}),
        ...(filters.itemId ? { itemId: filters.itemId } : {}),
        ...(filters.search
          ? {
              OR: [
                { text: { contains: filters.search, mode: 'insensitive' } },
                { title: { contains: filters.search, mode: 'insensitive' } },
                { itemId: { contains: filters.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
      take: 500,
    });
  }

  /** Contagem por status — alimenta os badges das abas da tela. */
  async counts(organizationId: string): Promise<Record<string, number>> {
    const rows = await this.prisma.knowledgeItem.groupBy({
      by: ['status'],
      where: { organizationId },
      _count: { _all: true },
    });
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r._count._all;
    return out;
  }

  async validate(id: string, organizationId: string, userId: string) {
    await this.assertOwned(id, organizationId);
    const updated = await this.prisma.knowledgeItem.update({
      where: { id },
      data: {
        status: KnowledgeStatus.VALIDATED,
        validatedById: userId,
        validatedAt: new Date(),
      },
    });
    await this.indexToRag(updated);
    return updated;
  }

  /** Rejeita (arquiva) — não some do banco, mas sai de circulação. */
  async reject(id: string, organizationId: string) {
    await this.assertOwned(id, organizationId);
    const updated = await this.prisma.knowledgeItem.update({
      where: { id },
      data: { status: KnowledgeStatus.ARCHIVED },
    });
    await this.deindexFromRag(organizationId, id);
    return updated;
  }

  async update(
    id: string,
    organizationId: string,
    dto: Partial<
      Pick<CreateKnowledgeInput, 'text' | 'title' | 'itemId' | 'type'>
    >,
  ) {
    await this.assertOwned(id, organizationId);
    const updated = await this.prisma.knowledgeItem.update({
      where: { id },
      data: {
        ...(dto.text !== undefined ? { text: dto.text.trim() } : {}),
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.itemId !== undefined ? { itemId: dto.itemId } : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
      },
    });
    // Re-indexa (texto pode ter mudado). deindex + index cobre os dois casos.
    await this.deindexFromRag(organizationId, id);
    await this.indexToRag(updated);
    return updated;
  }

  async remove(id: string, organizationId: string) {
    await this.assertOwned(id, organizationId);
    await this.deindexFromRag(organizationId, id);
    await this.prisma.knowledgeItem.delete({ where: { id } });
  }

  /**
   * Itens VALIDADOS que devem entrar no prompt: os GERAIS (itemId null) + os do
   * ANÚNCIO atual (se houver). Retorna o texto pronto pra injeção.
   */
  async getValidatedForPrompt(
    organizationId: string,
    itemId?: string | null,
  ): Promise<string[]> {
    const now = new Date();
    const rows = await this.prisma.knowledgeItem.findMany({
      where: {
        organizationId,
        status: KnowledgeStatus.VALIDATED,
        OR: itemId ? [{ itemId }, { itemId: null }] : [{ itemId: null }],
      },
      orderBy: { createdAt: 'desc' },
      take: 80,
      select: { text: true, expiresAt: true },
    });
    return rows
      .filter((r) => !r.expiresAt || r.expiresAt.getTime() > now.getTime())
      .map((r) => r.text);
  }

  /**
   * Substitui TODOS os itens de uma fonte (ex: AD_SCAN) por um novo conjunto —
   * reimport idempotente. Usado pela varredura de anúncios: cada rodada apaga o
   * mapa anterior e regrava o atual, evitando duplicatas/anúncios extintos.
   */
  async replaceBySource(
    organizationId: string,
    source: KnowledgeSource,
    items: CreateKnowledgeInput[],
  ): Promise<{ removed: number; created: number }> {
    return this.prisma.$transaction(async (tx) => {
      const del = await tx.knowledgeItem.deleteMany({
        where: { organizationId, source },
      });
      if (items.length === 0) return { removed: del.count, created: 0 };
      const created = await tx.knowledgeItem.createMany({
        data: items.map((i) => ({
          organizationId,
          type: i.type ?? KnowledgeType.VARIANT_MAP,
          status: i.status ?? KnowledgeStatus.VALIDATED,
          source,
          itemId: i.itemId ?? null,
          title: i.title ?? null,
          text: i.text,
          payload: (i.payload ?? {}) as Prisma.InputJsonValue,
          sourceRef: i.sourceRef ?? null,
        })),
      });
      return { removed: del.count, created: created.count };
    });
  }

  private async assertOwned(id: string, organizationId: string) {
    const row = await this.prisma.knowledgeItem.findUnique({ where: { id } });
    if (!row || row.organizationId !== organizationId) {
      throw new NotFoundException('Item de conhecimento não encontrado');
    }
    return row;
  }
}
