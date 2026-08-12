import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { AgentStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ConversationFsmService } from '../messaging/conversations/conversation-fsm.service';
import { LeadDistributionService } from '../lead-distribution/lead-distribution.service';

@Injectable()
export class RouterService {
  /** Round-robin cursor per organization + department */
  private readonly rrIndex = new Map<string, number>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly fsm: ConversationFsmService,
    private readonly leadDistribution: LeadDistributionService,
  ) {}

  async assignConversation(
    conversationId: string,
    organizationId: string,
    actorId?: string,
  ): Promise<{ departmentId: string; assignedToId: string }> {
    const conversation = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId },
    });
    if (!conversation) {
      throw new NotFoundException('Conversation not found');
    }

    const department = await this.prisma.department.findFirst({
      where: { organizationId, deletedAt: null },
      orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
    });
    if (!department) {
      throw new BadRequestException('No department configured for this organization');
    }

    // Distribuição ponderada SOBREPÕE o round-robin padrão quando ativa e
    // configurada: se ela retornar um vendedor, é ele que fica com o lead.
    const weightedUserId = await this.leadDistribution.pickForOrg(organizationId);
    if (weightedUserId) {
      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { departmentId: department.id },
      });
      await this.fsm.assign(conversationId, weightedUserId, actorId);
      return { departmentId: department.id, assignedToId: weightedUserId };
    }

    let agents = await this.prisma.departmentAgent.findMany({
      where: {
        departmentId: department.id,
        isActive: true,
        userOrganization: {
          organizationId,
          agentStatus: AgentStatus.ONLINE,
        },
      },
      include: { userOrganization: true },
      orderBy: { id: 'asc' },
    });

    if (agents.length === 0) {
      agents = await this.prisma.departmentAgent.findMany({
        where: {
          departmentId: department.id,
          isActive: true,
          userOrganization: { organizationId },
        },
        include: { userOrganization: true },
        orderBy: { id: 'asc' },
      });
    }

    if (agents.length === 0) {
      throw new BadRequestException('No active agents in the routing department');
    }

    const key = `${organizationId}:${department.id}`;
    const idx = this.rrIndex.get(key) ?? 0;
    const pick = agents[idx % agents.length];
    this.rrIndex.set(key, idx + 1);

    const assignedToId = pick.userOrganization.userId;

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { departmentId: department.id },
    });

    await this.fsm.assign(conversationId, assignedToId, actorId);

    return { departmentId: department.id, assignedToId };
  }
}
