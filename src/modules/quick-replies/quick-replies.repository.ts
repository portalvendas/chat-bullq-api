import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class QuickRepliesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.QuickReplyCreateInput) {
    return this.prisma.quickReply.create({ data });
  }

  async findByOrg(organizationId: string) {
    return this.prisma.quickReply.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: { shortcut: 'asc' },
    });
  }

  async findById(id: string) {
    return this.prisma.quickReply.findFirst({
      where: { id, deletedAt: null },
    });
  }

  async findByShortcut(organizationId: string, shortcut: string) {
    return this.prisma.quickReply.findFirst({
      where: { organizationId, shortcut, deletedAt: null },
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
