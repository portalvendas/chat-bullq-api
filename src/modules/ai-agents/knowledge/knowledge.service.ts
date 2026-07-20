import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  KnowledgeSource,
  KnowledgeStatus,
  KnowledgeType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

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

  constructor(private readonly prisma: PrismaService) {}

  async create(organizationId: string, input: CreateKnowledgeInput) {
    return this.prisma.knowledgeItem.create({
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
    return this.prisma.knowledgeItem.update({
      where: { id },
      data: {
        status: KnowledgeStatus.VALIDATED,
        validatedById: userId,
        validatedAt: new Date(),
      },
    });
  }

  /** Rejeita (arquiva) — não some do banco, mas sai de circulação. */
  async reject(id: string, organizationId: string) {
    await this.assertOwned(id, organizationId);
    return this.prisma.knowledgeItem.update({
      where: { id },
      data: { status: KnowledgeStatus.ARCHIVED },
    });
  }

  async update(
    id: string,
    organizationId: string,
    dto: Partial<
      Pick<CreateKnowledgeInput, 'text' | 'title' | 'itemId' | 'type'>
    >,
  ) {
    await this.assertOwned(id, organizationId);
    return this.prisma.knowledgeItem.update({
      where: { id },
      data: {
        ...(dto.text !== undefined ? { text: dto.text.trim() } : {}),
        ...(dto.title !== undefined ? { title: dto.title } : {}),
        ...(dto.itemId !== undefined ? { itemId: dto.itemId } : {}),
        ...(dto.type !== undefined ? { type: dto.type } : {}),
      },
    });
  }

  async remove(id: string, organizationId: string) {
    await this.assertOwned(id, organizationId);
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

  private async assertOwned(id: string, organizationId: string) {
    const row = await this.prisma.knowledgeItem.findUnique({ where: { id } });
    if (!row || row.organizationId !== organizationId) {
      throw new NotFoundException('Item de conhecimento não encontrado');
    }
    return row;
  }
}
