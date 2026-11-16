import { Injectable } from '@nestjs/common';
import { Prisma, OrgRole } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { randomBytes } from 'crypto';
import * as bcrypt from 'bcrypt';

@Injectable()
export class OrganizationsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string) {
    return this.prisma.organization.findFirst({
      where: { id, deletedAt: null },
    });
  }

  async findBySlug(slug: string) {
    return this.prisma.organization.findFirst({
      where: { slug, deletedAt: null },
    });
  }

  async update(id: string, data: Prisma.OrganizationUpdateInput) {
    return this.prisma.organization.update({ where: { id }, data });
  }

  async findMembers(organizationId: string) {
    return this.prisma.userOrganization.findMany({
      where: { organizationId, isVirtual: false }, // exclui vendedores virtuais (IA)
      include: {
        user: {
          select: { id: true, name: true, email: true, avatarUrl: true, isActive: true },
        },
        permissionGroup: { select: { id: true, name: true } },
      },
      orderBy: { joinedAt: 'asc' },
    });
  }

  /**
   * Aceita tanto o `userOrganization.id` (membership id, vem do listMembers
   * no frontend e é o que faz mais sentido pra rotas /members/:memberId)
   * quanto o `userId` (compatibilidade com chamadas legadas que passavam
   * o id do user direto). Tenta o id de membership primeiro porque é o
   * caso semanticamente correto da URL.
   */
  async findMembership(memberIdOrUserId: string, organizationId: string) {
    const byMembershipId = await this.prisma.userOrganization.findFirst({
      where: { id: memberIdOrUserId, organizationId },
    });
    if (byMembershipId) return byMembershipId;
    return this.prisma.userOrganization.findUnique({
      where: {
        userId_organizationId: { userId: memberIdOrUserId, organizationId },
      },
    });
  }

  async addMember(organizationId: string, userId: string, role: 'OWNER' | 'ADMIN' | 'AGENT') {
    return this.prisma.userOrganization.create({
      data: { organizationId, userId, role },
    });
  }

  async updateMemberRole(membershipId: string, role: 'OWNER' | 'ADMIN' | 'AGENT') {
    return this.prisma.userOrganization.update({
      where: { id: membershipId },
      data: { role },
    });
  }

  async removeMember(membershipId: string) {
    return this.prisma.userOrganization.delete({
      where: { id: membershipId },
    });
  }

  async findUserByEmail(email: string) {
    return this.prisma.user.findUnique({ where: { email } });
  }

  async countMembers(organizationId: string) {
    return this.prisma.userOrganization.count({ where: { organizationId } });
  }

  // ─── Invitation methods ───────────────────────────

  async createInvitation(organizationId: string, email: string, role: OrgRole, invitedById: string) {
    const token = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    return this.prisma.invitation.create({
      data: {
        organizationId,
        email,
        role,
        token,
        invitedById,
        expiresAt,
      },
      include: {
        organization: { select: { id: true, name: true, slug: true } },
      },
    });
  }

  async findInvitationByToken(token: string) {
    return this.prisma.invitation.findUnique({
      where: { token },
      include: {
        organization: { select: { id: true, name: true, slug: true } },
      },
    });
  }

  async findPendingInvitationsByEmail(email: string) {
    return this.prisma.invitation.findMany({
      where: {
        email,
        status: 'PENDING',
        expiresAt: { gt: new Date() },
      },
      include: {
        organization: { select: { id: true, name: true, slug: true } },
      },
    });
  }

  async acceptInvitation(invitationId: string) {
    return this.prisma.invitation.update({
      where: { id: invitationId },
      data: { status: 'ACCEPTED', acceptedAt: new Date() },
    });
  }

  async revokeInvitation(invitationId: string) {
    return this.prisma.invitation.update({
      where: { id: invitationId },
      data: { status: 'REVOKED' },
    });
  }

  async findInvitationsByOrg(organizationId: string) {
    return this.prisma.invitation.findMany({
      where: { organizationId },
      orderBy: { createdAt: 'desc' },
      include: {
        invitedBy: { select: { id: true, name: true, email: true } },
      },
    });
  }

  /** Busca um agente de IA ATIVO da org (valida que o agente pertence à org). */
  async findAiAgentInOrg(organizationId: string, aiAgentId: string) {
    return this.prisma.aiAgent.findFirst({
      where: { id: aiAgentId, organizationId, deletedAt: null },
      select: { id: true, name: true, isActive: true },
    });
  }

  /** Lista os vendedores virtuais (IA) da org, com user e agente vinculados. */
  async listVirtualSellers(organizationId: string) {
    return this.prisma.userOrganization.findMany({
      where: { organizationId, isVirtual: true },
      include: {
        user: { select: { id: true, name: true, email: true, avatarUrl: true, isActive: true } },
        aiAgent: { select: { id: true, name: true, isActive: true } },
      },
      orderBy: { joinedAt: 'asc' },
    });
  }

  /**
   * Cria um vendedor virtual: User placeholder SEM login (hash de senha
   * aleatório + e-mail reservado unico) + a membership marcada isVirtual.
   * Transacional: ou cria os dois, ou nenhum.
   */
  async createVirtualSeller(
    organizationId: string,
    data: { name: string; aiAgentId: string; avatarUrl?: string | null },
  ) {
    const unusablePassword = await bcrypt.hash(randomBytes(32).toString('hex'), 10);
    const email = `virtual.${randomBytes(9).toString('hex')}@kortia.local`;
    return this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: data.name,
          email,
          password: unusablePassword,
          avatarUrl: data.avatarUrl ?? null,
        },
      });
      return tx.userOrganization.create({
        data: {
          userId: user.id,
          organizationId,
          role: 'AGENT',
          isVirtual: true,
          aiAgentId: data.aiAgentId,
        },
        include: {
          user: { select: { id: true, name: true, email: true, avatarUrl: true, isActive: true } },
          aiAgent: { select: { id: true, name: true, isActive: true } },
        },
      });
    });
  }

  /** Membership de um vendedor virtual especifico (garante isVirtual + org). */
  async findVirtualSeller(membershipId: string, organizationId: string) {
    return this.prisma.userOrganization.findFirst({
      where: { id: membershipId, organizationId, isVirtual: true },
    });
  }

  /** Atualiza nome/avatar/ativo (no User) e/ou o agente vinculado (na membership). */
  async updateVirtualSeller(
    membershipId: string,
    userId: string,
    data: { name?: string; aiAgentId?: string; avatarUrl?: string | null; active?: boolean },
  ) {
    return this.prisma.$transaction(async (tx) => {
      if (data.name !== undefined || data.avatarUrl !== undefined || data.active !== undefined) {
        await tx.user.update({
          where: { id: userId },
          data: {
            ...(data.name !== undefined ? { name: data.name } : {}),
            ...(data.avatarUrl !== undefined ? { avatarUrl: data.avatarUrl } : {}),
            ...(data.active !== undefined ? { isActive: data.active } : {}),
          },
        });
      }
      return tx.userOrganization.update({
        where: { id: membershipId },
        data: { ...(data.aiAgentId !== undefined ? { aiAgentId: data.aiAgentId } : {}) },
        include: {
          user: { select: { id: true, name: true, email: true, avatarUrl: true, isActive: true } },
          aiAgent: { select: { id: true, name: true, isActive: true } },
        },
      });
    });
  }

  /**
   * Remove o vendedor virtual: apaga a membership (cascata nos agents de
   * canal/depto) e faz soft-delete do User placeholder (evita quebrar FKs de
   * conversas/mensagens antigas, que usam SetNull). Sem a membership, ele ja
   * sai do sorteio de distribuicao.
   */
  async deleteVirtualSeller(membershipId: string, userId: string) {
    await this.prisma.$transaction([
      this.prisma.userOrganization.delete({ where: { id: membershipId } }),
      this.prisma.user.update({
        where: { id: userId },
        data: { isActive: false, deletedAt: new Date() },
      }),
    ]);
  }

}
