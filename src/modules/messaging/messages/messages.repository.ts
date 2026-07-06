import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class MessagesRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.MessageUncheckedCreateInput) {
    return this.prisma.message.create({ data });
  }

  async findByConversation(
    conversationId: string,
    skip: number,
    take: number,
  ) {
    const [messages, total] = await this.prisma.$transaction([
      this.prisma.message.findMany({
        where: { conversationId },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
        include: {
          sender: { select: { id: true, name: true, avatarUrl: true } },
        },
      }),
      this.prisma.message.count({ where: { conversationId } }),
    ]);
    return { messages: messages.reverse(), total };
  }

  async findById(id: string) {
    return this.prisma.message.findUnique({ where: { id } });
  }

  async updateStatus(id: string, data: Prisma.MessageUpdateInput) {
    return this.prisma.message.update({ where: { id }, data });
  }
}
