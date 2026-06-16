import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { OrgRole } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

export type ChannelAccess = 'ALL' | Set<string>;

@Injectable()
export class ChannelAccessService {
  constructor(private readonly prisma: PrismaService) {}

  isBypassRole(role: OrgRole): boolean {
    return role === OrgRole.OWNER || role === OrgRole.ADMIN;
  }

  /**
   * Materializes which channels a user can see in the current org.
   *
   * Visibility rules:
   * - Channel.visibility = 'ORG'   → any member with normal channel rights
   *                                   (OWNER/ADMIN bypass, AGENT needs grant).
   * - Channel.visibility = 'PRIVATE' → ONLY explicit grants in ChannelAgent
   *                                    count, even for OWNER/ADMIN.
   *
   * Returns 'ALL' as an optimization when the user effectively sees every
   * non-deleted channel in the org (legacy behavior — kept so existing
   * Set-vs-ALL branches in callers don't need to materialize a Set on
   * every request when no private channels exist).
   */
  async getAccessibleChannelIds(
    userOrganizationId: string,
    role: OrgRole,
    organizationId?: string,
  ): Promise<ChannelAccess> {
    // AGENT: identical to before — only explicit grants.
    if (!this.isBypassRole(role)) {
      const rows = await this.prisma.channelAgent.findMany({
        where: { userOrganizationId },
        select: { channelId: true },
      });
      return new Set(rows.map((r) => r.channelId));
    }

    // OWNER/ADMIN path. We need the orgId to scope the query.
    let orgId = organizationId;
    if (!orgId) {
      const userOrg = await this.prisma.userOrganization.findUnique({
        where: { id: userOrganizationId },
        select: { organizationId: true },
      });
      orgId = userOrg?.organizationId;
    }
    if (!orgId) {
      // Defensive — shouldn't happen, fall back to no access.
      return new Set<string>();
    }

    // Fast path: org has zero private channels → behave exactly like before
    // ('ALL' shortcut means "no per-channel filter applied").
    const privateCount = await this.prisma.channel.count({
      where: { organizationId: orgId, visibility: 'PRIVATE', deletedAt: null },
    });
    if (privateCount === 0) return 'ALL';

    // Slow path: at least one private channel exists. Materialize the
    // exact set so private channels without a grant are excluded — even
    // for OWNERs.
    const channels = await this.prisma.channel.findMany({
      where: {
        organizationId: orgId,
        deletedAt: null,
        OR: [
          { visibility: 'ORG' },
          {
            visibility: 'PRIVATE',
            channelAgents: { some: { userOrganizationId } },
          },
        ],
      },
      select: { id: true },
    });
    return new Set(channels.map((c) => c.id));
  }

  hasAccess(access: ChannelAccess, channelId: string): boolean {
    return access === 'ALL' || access.has(channelId);
  }

  assertChannelAccess(access: ChannelAccess, channelId: string): void {
    if (!this.hasAccess(access, channelId)) {
      throw new ForbiddenException('You do not have access to this channel');
    }
  }

  async assertConversationAccess(
    access: ChannelAccess,
    conversationId: string,
  ): Promise<void> {
    if (access === 'ALL') return;

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { channelId: true },
    });
    if (!conversation) throw new NotFoundException('Conversation not found');
    this.assertChannelAccess(access, conversation.channelId);
  }

  /**
   * Look up the membership for a user in an org. Throws if not found.
   * Used by the admin endpoints that take `memberId` (a user id) in URL.
   */
  async getMembership(organizationId: string, userId: string) {
    const membership = await this.prisma.userOrganization.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { id: true, role: true, userId: true },
    });
    if (!membership) {
      throw new NotFoundException('Member not found in this organization');
    }
    return membership;
  }

  async listMemberChannels(organizationId: string, userId: string) {
    const membership = await this.getMembership(organizationId, userId);
    if (this.isBypassRole(membership.role)) {
      return {
        bypass: true as const,
        role: membership.role,
        channelIds: [] as string[],
      };
    }
    const grants = await this.prisma.channelAgent.findMany({
      where: { userOrganizationId: membership.id },
      select: { channelId: true },
    });
    return {
      bypass: false as const,
      role: membership.role,
      channelIds: grants.map((g) => g.channelId),
    };
  }

  /**
   * Replace the full set of channel grants for a member. Returns the diff
   * (added + removed) so callers can push live socket-room updates without
   * forcing a reconnect.
   */
  async setMemberChannels(
    organizationId: string,
    userId: string,
    channelIds: string[],
    grantedById: string,
  ): Promise<{ added: string[]; removed: string[]; userId: string }> {
    const membership = await this.getMembership(organizationId, userId);
    // OWNER/ADMIN ainda bypassam canais ORG sem grant, mas grants explícitos
    // continuam relevantes pra canais PRIVATE — então a operação é válida.

    const validChannels = await this.prisma.channel.findMany({
      where: { id: { in: channelIds }, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (validChannels.length !== channelIds.length) {
      throw new BadRequestException(
        'One or more channelIds are invalid for this organization.',
      );
    }

    const existing = await this.prisma.channelAgent.findMany({
      where: { userOrganizationId: membership.id },
      select: { channelId: true },
    });
    const existingSet = new Set(existing.map((e) => e.channelId));
    const targetSet = new Set(channelIds);

    const toAdd = channelIds.filter((id) => !existingSet.has(id));
    const toRemove = [...existingSet].filter((id) => !targetSet.has(id));

    await this.prisma.$transaction([
      ...(toRemove.length
        ? [
            this.prisma.channelAgent.deleteMany({
              where: {
                userOrganizationId: membership.id,
                channelId: { in: toRemove },
              },
            }),
          ]
        : []),
      ...toAdd.map((channelId) =>
        this.prisma.channelAgent.create({
          data: {
            channelId,
            userOrganizationId: membership.id,
            grantedById,
          },
        }),
      ),
    ]);

    return { added: toAdd, removed: toRemove, userId: membership.userId };
  }

  async addChannelAgent(
    organizationId: string,
    channelId: string,
    userId: string,
    grantedById: string,
  ): Promise<{ userId: string }> {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    const membership = await this.getMembership(organizationId, userId);
    // Pra canais PRIVATE até OWNER/ADMIN precisa de grant explícito —
    // por isso não bloqueamos mais a operação por role.

    await this.prisma.channelAgent.upsert({
      where: {
        channelId_userOrganizationId: {
          channelId,
          userOrganizationId: membership.id,
        },
      },
      update: {},
      create: {
        channelId,
        userOrganizationId: membership.id,
        grantedById,
      },
    });

    return { userId: membership.userId };
  }

  async removeChannelAgent(
    organizationId: string,
    channelId: string,
    userId: string,
  ): Promise<{ userId: string }> {
    const membership = await this.getMembership(organizationId, userId);
    await this.prisma.channelAgent.deleteMany({
      where: {
        channelId,
        userOrganizationId: membership.id,
      },
    });
    return { userId: membership.userId };
  }

  async listChannelAgents(organizationId: string, channelId: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    const grants = await this.prisma.channelAgent.findMany({
      where: { channelId },
      include: {
        userOrganization: {
          include: {
            user: {
              select: { id: true, name: true, email: true, avatarUrl: true },
            },
          },
        },
      },
    });
    return grants.map((g) => ({
      grantId: g.id,
      grantedAt: g.grantedAt,
      user: g.userOrganization.user,
      role: g.userOrganization.role,
    }));
  }

  /**
   * Switch a channel between ORG (everyone in the org sees it) and
   * PRIVATE (only explicit grants see it). When flipping to PRIVATE,
   * we auto-grant the caller so they don't lock themselves out — and
   * if no other grants exist, only they keep access. The caller can
   * then add others through the normal grant API.
   */
  async setChannelVisibility(
    channelId: string,
    organizationId: string,
    visibility: 'ORG' | 'PRIVATE',
    callerUserOrganizationId: string,
  ): Promise<{ id: string; visibility: 'ORG' | 'PRIVATE' }> {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, organizationId, deletedAt: null },
      select: { id: true, visibility: true },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    if (channel.visibility === visibility) {
      return { id: channel.id, visibility };
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.channel.update({
        where: { id: channelId },
        data: { visibility },
      });

      if (visibility === 'PRIVATE') {
        // Auto-grant ao caller pra ele não perder acesso ao próprio canal.
        await tx.channelAgent.upsert({
          where: {
            channelId_userOrganizationId: {
              channelId,
              userOrganizationId: callerUserOrganizationId,
            },
          },
          update: {},
          create: {
            channelId,
            userOrganizationId: callerUserOrganizationId,
            grantedById: null,
          },
        });
      }
    });

    return { id: channel.id, visibility };
  }

  /**
   * Members eligible to handle a conversation in the given channel — used by
   * the assignee picker. Includes OWNER/ADMIN (always eligible) and AGENTs
   * with an explicit grant. Excludes inactive users.
   */
  async listEligibleAgents(organizationId: string, channelId: string) {
    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, organizationId, deletedAt: null },
      select: { id: true, visibility: true },
    });
    if (!channel) throw new NotFoundException('Channel not found');

    // Pra canal PRIVATE, OWNER/ADMIN não é elegível automaticamente — só
    // membros com grant explícito aparecem na lista de assignees.
    const baseWhere =
      channel.visibility === 'PRIVATE'
        ? { channelAgents: { some: { channelId } } }
        : {
            OR: [
              { role: { in: [OrgRole.OWNER, OrgRole.ADMIN] } },
              { channelAgents: { some: { channelId } } },
            ],
          };

    const memberships = await this.prisma.userOrganization.findMany({
      where: {
        organizationId,
        user: { isActive: true, deletedAt: null },
        ...baseWhere,
      },
      include: {
        user: {
          select: { id: true, name: true, email: true, avatarUrl: true },
        },
      },
    });
    return memberships.map((m) => ({
      ...m.user,
      role: m.role,
    }));
  }
}
