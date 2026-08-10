import {
  Injectable,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  EffectivePermissions,
  defaultAgentModules,
  everyModule,
  normalizeModules,
} from './permission-groups.constants';

export interface PermissionGroupInput {
  name: string;
  description?: string | null;
  modulePerms?: Record<string, { view?: boolean; edit?: boolean; delete?: boolean }>;
  allChannels?: boolean;
  channelIds?: string[];
  allPipelines?: boolean;
  pipelineIds?: string[];
}

@Injectable()
export class PermissionGroupsService {
  constructor(private readonly prisma: PrismaService) {}

  list(organizationId: string) {
    return this.prisma.permissionGroup.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
      include: { _count: { select: { members: true } } },
    });
  }

  async create(organizationId: string, dto: PermissionGroupInput) {
    if (!dto.name?.trim()) throw new BadRequestException('Nome obrigatório');
    return this.prisma.permissionGroup.create({
      data: {
        organizationId,
        name: dto.name.trim(),
        description: dto.description ?? null,
        modulePerms: (dto.modulePerms ?? {}) as any,
        allChannels: dto.allChannels ?? true,
        channelIds: (dto.channelIds ?? []) as any,
        allPipelines: dto.allPipelines ?? true,
        pipelineIds: (dto.pipelineIds ?? []) as any,
      },
    });
  }

  private async assertGroup(id: string, organizationId: string) {
    const g = await this.prisma.permissionGroup.findUnique({ where: { id } });
    if (!g || g.organizationId !== organizationId) {
      throw new NotFoundException('Grupo não encontrado');
    }
    return g;
  }

  async update(id: string, organizationId: string, dto: PermissionGroupInput) {
    await this.assertGroup(id, organizationId);
    return this.prisma.permissionGroup.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
        ...(dto.description !== undefined ? { description: dto.description } : {}),
        ...(dto.modulePerms !== undefined ? { modulePerms: dto.modulePerms as any } : {}),
        ...(dto.allChannels !== undefined ? { allChannels: dto.allChannels } : {}),
        ...(dto.channelIds !== undefined ? { channelIds: dto.channelIds as any } : {}),
        ...(dto.allPipelines !== undefined ? { allPipelines: dto.allPipelines } : {}),
        ...(dto.pipelineIds !== undefined ? { pipelineIds: dto.pipelineIds as any } : {}),
      },
    });
  }

  async remove(id: string, organizationId: string) {
    await this.assertGroup(id, organizationId);
    // FK ON DELETE SET NULL desvincula os membros automaticamente.
    await this.prisma.permissionGroup.delete({ where: { id } });
  }

  /** Vincula (ou desvincula com null) um grupo a um membro (userOrganization). */
  async assign(
    organizationId: string,
    memberId: string,
    permissionGroupId: string | null,
  ) {
    const member = await this.prisma.userOrganization.findUnique({
      where: { id: memberId },
    });
    if (!member || member.organizationId !== organizationId) {
      throw new NotFoundException('Membro não encontrado');
    }
    if (permissionGroupId) await this.assertGroup(permissionGroupId, organizationId);
    return this.prisma.userOrganization.update({
      where: { id: memberId },
      data: { permissionGroupId },
    });
  }

  /** Permissões EFETIVAS do usuário na org (Owner/Admin = tudo). */
  async resolveEffective(
    userId: string,
    organizationId: string,
  ): Promise<EffectivePermissions | null> {
    const m = await this.prisma.userOrganization.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      include: { permissionGroup: true, channelAgents: true },
    });
    if (!m) return null;

    const role = m.role as EffectivePermissions['role'];
    if (role === 'OWNER' || role === 'ADMIN') {
      return {
        role,
        fullAccess: true,
        permissionGroupId: null,
        modules: everyModule({ view: true, edit: true, delete: true }),
        channels: { all: true, ids: [] },
        pipelines: { all: true, ids: [] },
      };
    }

    const g = m.permissionGroup;
    if (g) {
      return {
        role,
        fullAccess: false,
        permissionGroupId: g.id,
        modules: normalizeModules(g.modulePerms),
        channels: {
          all: g.allChannels,
          ids: Array.isArray(g.channelIds) ? (g.channelIds as string[]) : [],
        },
        pipelines: {
          all: g.allPipelines,
          ids: Array.isArray(g.pipelineIds) ? (g.pipelineIds as string[]) : [],
        },
      };
    }

    // Agente sem grupo: baseline (preserva comportamento atual).
    return {
      role,
      fullAccess: false,
      permissionGroupId: null,
      modules: defaultAgentModules(),
      channels: { all: false, ids: m.channelAgents.map((c) => c.channelId) },
      pipelines: { all: true, ids: [] },
    };
  }
}
