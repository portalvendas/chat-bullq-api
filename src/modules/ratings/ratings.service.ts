import { Injectable, BadRequestException, NotFoundException, Logger } from '@nestjs/common';
import { randomBytes } from 'crypto';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class RatingsService {
  private readonly logger = new Logger(RatingsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async requestRating(conversationId: string) {
    const conv = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, organizationId: true, assignedToId: true },
    });
    if (!conv) return null;

    const existing = await this.prisma.conversationRating.findUnique({
      where: { conversationId },
    });
    if (existing) return existing;

    const token = randomBytes(24).toString('hex');
    return this.prisma.conversationRating.create({
      data: {
        conversationId,
        organizationId: conv.organizationId,
        agentId: conv.assignedToId,
        score: 0,
        token,
      },
    });
  }

  async submitByToken(token: string, score: number, comment?: string) {
    if (!Number.isInteger(score) || score < 1 || score > 5) {
      throw new BadRequestException('Score must be an integer between 1 and 5');
    }
    const rating = await this.prisma.conversationRating.findUnique({ where: { token } });
    if (!rating) throw new NotFoundException('Rating request not found');
    if (rating.respondedAt) throw new BadRequestException('Rating already submitted');

    return this.prisma.conversationRating.update({
      where: { token },
      data: { score, comment, respondedAt: new Date() },
      select: { id: true, score: true, respondedAt: true },
    });
  }

  async listForOrg(organizationId: string, limit = 50) {
    return this.prisma.conversationRating.findMany({
      where: { organizationId, respondedAt: { not: null } },
      orderBy: { respondedAt: 'desc' },
      take: limit,
      include: {
        conversation: {
          select: {
            id: true,
            contact: { select: { id: true, name: true } },
            assignedTo: { select: { id: true, name: true } },
          },
        },
      },
    });
  }
}
