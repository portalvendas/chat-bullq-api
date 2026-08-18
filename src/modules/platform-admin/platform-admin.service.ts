import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OrgRole, Prisma } from '@prisma/client';
import type { SignOptions } from 'jsonwebtoken';
import { PrismaService } from '../../database/prisma.service';
import { TENANT_MODELS } from '../../common/tenant/tenant-models';

/** Ator (super-admin) que executa uma ação — pra auditoria. */
export interface PlatformActor {
  userId: string;
  ipAddress?: string;
}

interface ListParams {
  cursor?: string;
  limit?: number;
  search?: string;
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * Regras do console de super-admin (plataforma). Opera ACIMA das orgs —
 * nenhuma query aqui é escopada por organizationId (é justamente a visão
 * cross-tenant). Segredos de canal (config/webhookSecret) NUNCA são
 * retornados. Toda mutação grava em PlatformAuditLog.
 */
@Injectable()
export class PlatformAdminService {
  private readonly logger = new Logger(PlatformAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

  private clampLimit(limit?: number): number {
    if (!limit || limit < 1) return DEFAULT_LIMIT;
    return Math.min(limit, MAX_LIMIT);
  }

  /** Paginação cursor: pega limit+1 pra saber se há próxima página. */
  private cursorArgs(cursor?: string): { cursor?: { id: string }; skip?: number } {
    return cursor ? { cursor: { id: cursor }, skip: 1 } : {};
  }

  // ─────────────────────────────────────────────────────────────
  // Overview / métricas da plataforma
  // ─────────────────────────────────────────────────────────────
  async overview() {
    const [
      orgsTotal,
      orgsSuspended,
      usersTotal,
      usersActive,
      channelsTotal,
      conversationsTotal,
    ] = await Promise.all([
      this.prisma.organization.count({ where: { deletedAt: null } }),
      this.prisma.organization.count({
        where: { deletedAt: null, suspendedAt: { not: null } },
      }),
      this.prisma.user.count({ where: { deletedAt: null } }),
      this.prisma.user.count({ where: { deletedAt: null, isActive: true } }),
      this.prisma.channel.count({ where: { deletedAt: null } }),
      this.prisma.conversation.count(),
    ]);

    return {
      organizations: {
        total: orgsTotal,
        active: orgsTotal - orgsSuspended,
        suspended: orgsSuspended,
      },
      users: { total: usersTotal, active: usersActive },
      channels: { total: channelsTotal },
      conversations: { total: conversationsTotal },
    };
  }

  // ─────────────────────────────────────────────────────────────
  // Organizações
  // ─────────────────────────────────────────────────────────────
  async listOrganizations(params: ListParams) {
    const limit = this.clampLimit(params.limit);
    const search = params.search?.trim();

    const where: Prisma.OrganizationWhereInput = {
      deletedAt: null,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { slug: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.organization.findMany({
      where,
      take: limit + 1,
      ...this.cursorArgs(params.cursor),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        slug: true,
        plan: true,
        suspendedAt: true,
        createdAt: true,
        _count: {
          select: { members: true, channels: true, conversations: true },
        },
      },
    });

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((o) => ({
      id: o.id,
      name: o.name,
      slug: o.slug,
      plan: o.plan,
      status: o.suspendedAt ? 'suspended' : 'active',
      suspendedAt: o.suspendedAt,
      createdAt: o.createdAt,
      counts: {
        members: o._count.members,
        channels: o._count.channels,
        conversations: o._count.conversations,
      },
    }));

    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  async getOrganization(id: string) {
    const org = await this.prisma.organization.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        plan: true,
        suspendedAt: true,
        suspendedReason: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: { members: true, channels: true, conversations: true },
        },
        members: {
          select: {
            id: true,
            role: true,
            joinedAt: true,
            user: { select: { id: true, name: true, email: true, isActive: true } },
          },
          orderBy: { joinedAt: 'asc' },
        },
        // Canais SEM segredos (config/webhookSecret nunca são expostos).
        channels: {
          where: { deletedAt: null },
          select: {
            id: true,
            name: true,
            type: true,
            isActive: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!org) throw new NotFoundException('Organização não encontrada');

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      plan: org.plan,
      status: org.suspendedAt ? 'suspended' : 'active',
      suspendedAt: org.suspendedAt,
      suspendedReason: org.suspendedReason,
      createdAt: org.createdAt,
      updatedAt: org.updatedAt,
      counts: {
        members: org._count.members,
        channels: org._count.channels,
        conversations: org._count.conversations,
      },
      members: org.members.map((m) => ({
        userOrganizationId: m.id,
        role: m.role,
        joinedAt: m.joinedAt,
        user: m.user,
      })),
      channels: org.channels,
    };
  }

  async suspendOrganization(id: string, reason: string | undefined, actor: PlatformActor) {
    const org = await this.prisma.organization.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, suspendedAt: true },
    });
    if (!org) throw new NotFoundException('Organização não encontrada');

    const updated = await this.prisma.organization.update({
      where: { id },
      data: { suspendedAt: new Date(), suspendedReason: reason ?? null },
      select: { id: true, name: true, suspendedAt: true, suspendedReason: true },
    });

    await this.audit(actor, 'ORGANIZATION_SUSPENDED', 'Organization', id, id, {
      reason: reason ?? null,
    });
    this.logger.warn(`Org ${id} suspensa por ${actor.userId} (motivo: ${reason ?? '-'})`);
    return { ...updated, status: 'suspended' as const };
  }

  async reactivateOrganization(id: string, actor: PlatformActor) {
    const org = await this.prisma.organization.findFirst({
      where: { id, deletedAt: null },
      select: { id: true },
    });
    if (!org) throw new NotFoundException('Organização não encontrada');

    const updated = await this.prisma.organization.update({
      where: { id },
      data: { suspendedAt: null, suspendedReason: null },
      select: { id: true, name: true, suspendedAt: true },
    });

    await this.audit(actor, 'ORGANIZATION_REACTIVATED', 'Organization', id, id, {});
    this.logger.warn(`Org ${id} reativada por ${actor.userId}`);
    return { ...updated, status: 'active' as const };
  }

  async updatePlan(id: string, plan: string, actor: PlatformActor) {
    const org = await this.prisma.organization.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, plan: true },
    });
    if (!org) throw new NotFoundException('Organização não encontrada');

    const updated = await this.prisma.organization.update({
      where: { id },
      data: { plan },
      select: { id: true, name: true, plan: true },
    });

    await this.audit(actor, 'ORGANIZATION_PLAN_CHANGED', 'Organization', id, id, {
      from: org.plan,
      to: plan,
    });
    return updated;
  }

  // ─────────────────────────────────────────────────────────────
  // Usuários (visão de plataforma)
  // ─────────────────────────────────────────────────────────────
  async listUsers(params: ListParams) {
    const limit = this.clampLimit(params.limit);
    const search = params.search?.trim();

    const where: Prisma.UserWhereInput = {
      deletedAt: null,
      ...(search
        ? {
            OR: [
              { name: { contains: search, mode: 'insensitive' } },
              { email: { contains: search, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const rows = await this.prisma.user.findMany({
      where,
      take: limit + 1,
      ...this.cursorArgs(params.cursor),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        email: true,
        isActive: true,
        platformRole: true,
        createdAt: true,
        organizations: {
          select: {
            role: true,
            organization: { select: { id: true, name: true, slug: true } },
          },
        },
      },
    });

    const hasMore = rows.length > limit;
    const items = (hasMore ? rows.slice(0, limit) : rows).map((u) => ({
      id: u.id,
      name: u.name,
      email: u.email,
      isActive: u.isActive,
      platformRole: u.platformRole,
      createdAt: u.createdAt,
      organizations: u.organizations.map((m) => ({
        role: m.role,
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
      })),
    }));

    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  // ─────────────────────────────────────────────────────────────
  // Trilha de auditoria
  // ─────────────────────────────────────────────────────────────
  async listAuditLogs(params: ListParams & { organizationId?: string }) {
    const limit = this.clampLimit(params.limit);
    const rows = await this.prisma.platformAuditLog.findMany({
      where: params.organizationId ? { organizationId: params.organizationId } : {},
      take: limit + 1,
      ...this.cursorArgs(params.cursor),
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        action: true,
        targetType: true,
        targetId: true,
        organizationId: true,
        metadata: true,
        ipAddress: true,
        createdAt: true,
        actor: { select: { id: true, name: true, email: true } },
      },
    });
    const hasMore = rows.length > limit;
    const items = hasMore ? rows.slice(0, limit) : rows;
    return { items, nextCursor: hasMore ? items[items.length - 1].id : null };
  }

  // ─────────────────────────────────────────────────────────────
  // Impersonação (agir como um membro da org) — AUDITADA
  // ─────────────────────────────────────────────────────────────
  /**
   * Emite um token de impersonação: o super-admin passa a agir como um MEMBRO
   * real da org (sub = membro), então toda a semântica de org (membership,
   * canais, papel) funciona sem gambiarra. O token:
   *  - é curto (IMPERSONATION_EXPIRATION, default 30m) e SEM refresh;
   *  - carrega `imp: { by, org }` — escopado a UMA org (OrgGuard valida);
   *  - não acessa o console (sub não é super-admin → PlatformAdminGuard nega).
   * Se `targetUserId` não vier, auto-seleciona um OWNER (senão ADMIN, senão
   * qualquer membro ativo). Grava IMPERSONATION_STARTED na auditoria.
   */
  async impersonate(
    organizationId: string,
    actor: PlatformActor,
    targetUserId?: string,
  ) {
    const org = await this.prisma.organization.findFirst({
      where: { id: organizationId, deletedAt: null },
      select: { id: true, name: true },
    });
    if (!org) throw new NotFoundException('Organização não encontrada');

    type Member = {
      userId: string;
      role: OrgRole;
      user: { id: string; name: string; email: string; isActive: boolean };
    };
    let target: Member;

    if (targetUserId) {
      const m = await this.prisma.userOrganization.findUnique({
        where: {
          userId_organizationId: { userId: targetUserId, organizationId },
        },
        select: {
          userId: true,
          role: true,
          user: { select: { id: true, name: true, email: true, isActive: true } },
        },
      });
      if (!m) throw new NotFoundException('Usuário não é membro desta organização');
      if (!m.user.isActive)
        throw new BadRequestException('Usuário-alvo está inativo');
      target = m;
    } else {
      const members = await this.prisma.userOrganization.findMany({
        where: { organizationId, user: { isActive: true, deletedAt: null } },
        select: {
          userId: true,
          role: true,
          user: { select: { id: true, name: true, email: true, isActive: true } },
        },
      });
      if (members.length === 0)
        throw new BadRequestException(
          'Organização sem membros ativos para impersonar',
        );
      target =
        members.find((m) => m.role === 'OWNER') ??
        members.find((m) => m.role === 'ADMIN') ??
        members[0];
    }

    const expiresIn = (process.env.IMPERSONATION_EXPIRATION ??
      '30m') as SignOptions['expiresIn'];
    const token = await this.jwt.signAsync(
      {
        sub: target.userId,
        email: target.user.email,
        imp: { by: actor.userId, org: organizationId },
      },
      { secret: process.env.JWT_SECRET, expiresIn },
    );

    await this.audit(
      actor,
      'IMPERSONATION_STARTED',
      'User',
      target.userId,
      organizationId,
      { targetEmail: target.user.email, role: target.role, expiresIn: String(expiresIn) },
    );
    this.logger.warn(
      `Impersonação iniciada: ${actor.userId} → org ${organizationId} como ${target.user.email} (${target.role})`,
    );

    return {
      token,
      tokenType: 'Bearer' as const,
      expiresIn: String(expiresIn),
      organization: { id: org.id, name: org.name },
      actingAs: {
        id: target.user.id,
        name: target.user.name,
        email: target.user.email,
        role: target.role,
      },
    };
  }

  /**
   * Grava um evento de auditoria. Nunca derruba a operação principal —
   * falha de auditoria é logada mas não propagada (a mutação já ocorreu).
   */
  /**
   * LGPD/portabilidade: dump estruturado de TODOS os dados da org (tabelas
   * tenant + mensagens). Segredos de canal (config/webhookSecret) sao
   * REDIGIDOS — nao exportamos tokens em texto puro.
   */
  async exportOrganization(id: string) {
    const org = await this.prisma.organization.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        plan: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!org) throw new NotFoundException('Organizacao nao encontrada');

    const data: Record<string, unknown> = {
      exportedAt: new Date().toISOString(),
      organization: org,
    };

    for (const model of TENANT_MODELS) {
      const accessor = model.charAt(0).toLowerCase() + model.slice(1);
      const client = (this.prisma as any)[accessor];
      if (!client?.findMany) continue;
      try {
        const rows = await client.findMany({ where: { organizationId: id } });
        data[accessor] =
          model === 'Channel'
            ? rows.map((c: Record<string, unknown>) => ({
                ...c,
                config: '[REDACTED]',
                webhookSecret: '[REDACTED]',
              }))
            : rows;
      } catch (err: any) {
        data[accessor] = { error: err?.message ?? 'falha ao exportar' };
      }
    }

    // Mensagens sao filhas de conversa (nao tem organizationId direto).
    data.message = await this.prisma.message.findMany({
      where: { conversation: { organizationId: id } },
    });

    return data;
  }

  /**
   * LGPD/offboarding: EXCLUSAO DEFINITIVA da org e de tudo relacionado. O delete
   * cascateia no banco (FKs onDelete: Cascade), entao e atomico. Irreversivel —
   * exige confirmacao com o slug e e auditado ANTES (o platform_audit_log
   * sobrevive: organizationId vira null via SetNull).
   */
  async purgeOrganization(
    id: string,
    actor: PlatformActor,
    confirmSlug: string,
  ) {
    const org = await this.prisma.organization.findFirst({
      where: { id },
      select: { id: true, name: true, slug: true },
    });
    if (!org) throw new NotFoundException('Organizacao nao encontrada');
    if (!confirmSlug || confirmSlug !== org.slug) {
      throw new BadRequestException(
        'Confirmacao invalida: informe o slug exato da empresa para excluir.',
      );
    }

    await this.audit(actor, 'ORGANIZATION_PURGED', 'Organization', id, id, {
      name: org.name,
      slug: org.slug,
    });

    await this.prisma.organization.delete({ where: { id } });

    this.logger.warn(
      `Org ${id} (${org.slug}) EXCLUIDA DEFINITIVAMENTE por ${actor.userId}`,
    );
    return { id, slug: org.slug, purged: true };
  }

  private async audit(
    actor: PlatformActor,
    action: string,
    targetType: string,
    targetId: string | null,
    organizationId: string | null,
    metadata: Prisma.InputJsonValue,
  ): Promise<void> {
    try {
      await this.prisma.platformAuditLog.create({
        data: {
          actorUserId: actor.userId,
          action,
          targetType,
          targetId,
          organizationId,
          ipAddress: actor.ipAddress ?? null,
          metadata,
        },
      });
    } catch (err: any) {
      this.logger.error(
        `Falha ao gravar auditoria (${action} ${targetType}:${targetId}): ${err?.message}`,
      );
    }
  }
}
