import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class QuickRepliesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.QuickReplyCreateInput) {
    return this.prisma.quickReply.create({ data });
  }

  /** Compartilhadas da org (user_id null) + as pessoais DESTE usuário. */
  async findVisible(organizationId: string, userId: string) {
    return this.prisma.quickReply.findMany({
      where: {
        organizationId,
        deletedAt: null,
        OR: [{ userId: null }, { userId }],
      },
      orderBy: [{ userId: 'asc' }, { shortcut: 'asc' }],
    });
  }

  async findById(id: string) {
    return this.prisma.quickReply.findFirst({
      where: { id, deletedAt: null },
    });
  }

  /** Atalho já usado DENTRO do mesmo escopo (mesma org + mesmo dono). */
  async findByShortcutScoped(
    organizationId: string,
    userId: string | null,
    shortcut: string,
  ) {
    return this.prisma.quickReply.findFirst({
      where: { organizationId, userId, shortcut, deletedAt: null },
    });
  }

  async update(id: string, data: Prisma.QuickReplyUpdateInput) {
    return this.prisma.quickReply.update({ where: { id }, data });
  }

  async softDelete(id: string) {
    return this.prisma.quickReply.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }
}
