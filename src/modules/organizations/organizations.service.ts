import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  ConflictException,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { OrgRole, Prisma } from '@prisma/client';
import { OrganizationsRepository } from './organizations.repository';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { MailService } from '../mail/mail.service';

const DEFAULT_LOSS_REASONS = [
  'Não respondeu a mensagem inicial',
  'Não informou',
  'Orçamento insuficiente',
  'O produto não se encaixa à necessidade',
  'Comprado do concorrente',
  'Frete caro',
  'Frete lento',
  'Em fase de construção',
  'Não está no momento/precisa de tempo',
];

@Injectable()
export class OrganizationsService {
  private readonly logger = new Logger(OrganizationsService.name);

  constructor(
    private readonly repository: OrganizationsRepository,
    private readonly mail: MailService,
  ) {}

  async getOrganization(orgId: string) {
    const org = await this.repository.findById(orgId);
    if (!org) throw new NotFoundException('Organization not found');
    return org;
  }

  /** Motivos de perda configurados (org.settings.lossReasons). */
  async getLossReasons(orgId: string): Promise<{ reasons: string[] }> {
    const org = await this.getOrganization(orgId);
    const settings = (org.settings as Record<string, any>) ?? {};
    const reasons = Array.isArray(settings.lossReasons)
      ? (settings.lossReasons as string[])
      : DEFAULT_LOSS_REASONS;
    return { reasons };
  }

  async setLossReasons(
    orgId: string,
    reasons: string[],
  ): Promise<{ reasons: string[] }> {
    const org = await this.getOrganization(orgId);
    const clean = (reasons ?? [])
      .map((r) => String(r).trim())
      .filter((r) => r.length > 0)
      .slice(0, 30);
    const settings = {
      ...((org.settings as Record<string, any>) ?? {}),
      lossReasons: clean,
    };
    await this.repository.update(orgId, {
      settings: settings as Prisma.InputJsonValue,
    });
    return { reasons: clean };
  }

  async updateOrganization(orgId: string, dto: UpdateOrganizationDto) {
    await this.getOrganization(orgId);
    const {
      aiBusinessHours,
      watchdogBusinessHours,
      watchdogConfig,
      allowedUrlDomains,
      ...rest
    } = dto;
    return this.repository.update(orgId, {
      ...rest,
      ...(aiBusinessHours !== undefined
        ? { aiBusinessHours: aiBusinessHours as object }
        : {}),
      ...(watchdogBusinessHours !== undefined
        ? { watchdogBusinessHours: watchdogBusinessHours as object }
        : {}),
      ...(watchdogConfig !== undefined
        ? { watchdogConfig: watchdogConfig as object }
        : {}),
      ...(allowedUrlDomains !== undefined
        ? {
            allowedUrlDomains:
              allowedUrlDomains === null
                ? Prisma.JsonNull
                : (allowedUrlDomains as Prisma.InputJsonValue),
          }
        : {}),
    });
  }

  async getMembers(orgId: string) {
    return this.repository.findMembers(orgId);
  }

  async inviteMember(orgId: string, dto: InviteMemberDto, inviterId: string) {
    // Check if user already exists and is already a member
    const existingUser = await this.repository.findUserByEmail(dto.email);
    if (existingUser) {
      const existingMembership = await this.repository.findMembership(existingUser.id, orgId);
      if (existingMembership) {
        throw new ConflictException('User is already a member of this organization');
      }
    }

    // Create invitation (works for both existing and non-existing users)
    const invitation = await this.repository.createInvitation(orgId, dto.email, dto.role, inviterId);
    this.logger.log(`Invitation sent to ${dto.email} for org ${orgId} by ${inviterId}`);

    // Usuário já existe (ex.: sobra de uma empresa excluída e recriada): já
    // vincula à empresa, MAS mantém o convite PENDENTE e envia o e-mail. Antes
    // marcávamos como ACEITO sem mandar link — a pessoa ficava membro sem senha
    // conhecida e sem como entrar. Agora ela sempre recebe um link pra definir
    // a senha e acessar (o registro por convite reaproveita a conta existente).
    if (existingUser) {
      await this.repository.addMember(orgId, existingUser.id, dto.role);
      this.logger.log(`User ${dto.email} vinculado à org ${orgId} (já existia) — convite pendente enviado`);
    }

    // Dispara o convite por e-mail (novo ou existente). Best-effort: uma falha
    // de e-mail não deve derrubar a criação do convite/vínculo.
    try {
      await this.mail.sendInvitation({
        to: dto.email,
        orgName: invitation.organization.name,
        token: invitation.token,
        role: dto.role,
      });
    } catch (err) {
      this.logger.warn(`Falha ao enviar e-mail de convite para ${dto.email}: ${(err as Error)?.message}`);
    }

    return { ...invitation, autoAccepted: false, memberAdded: !!existingUser };
  }

  async validateInvitation(token: string) {
    const invitation = await this.repository.findInvitationByToken(token);
    if (!invitation) {
      throw new NotFoundException('Invitation not found');
    }
    if (invitation.status !== 'PENDING') {
      throw new BadRequestException(`Invitation has already been ${invitation.status.toLowerCase()}`);
    }
    if (invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitation has expired');
    }
    return {
      email: invitation.email,
      role: invitation.role,
      organization: invitation.organization,
    };
  }

  async getInvitations(orgId: string) {
    return this.repository.findInvitationsByOrg(orgId);
  }

  async revokeInvitation(orgId: string, invitationId: string) {
    const invitations = await this.repository.findInvitationsByOrg(orgId);
    const invitation = invitations.find((i) => i.id === invitationId);
    if (!invitation) {
      throw new NotFoundException('Invitation not found in this organization');
    }
    if (invitation.status !== 'PENDING') {
      throw new BadRequestException('Only pending invitations can be revoked');
    }
    return this.repository.revokeInvitation(invitationId);
  }

  async updateMemberRole(orgId: string, memberId: string, dto: UpdateMemberRoleDto, actorRole: OrgRole) {
    const membership = await this.repository.findMembership(memberId, orgId);
    if (!membership) {
      throw new NotFoundException('Member not found in this organization');
    }

    if (membership.role === 'OWNER' && dto.role !== 'OWNER') {
      throw new ForbiddenException('Cannot change the role of the organization owner');
    }

    if (actorRole === 'ADMIN' && dto.role === 'OWNER') {
      throw new ForbiddenException('Only owners can assign the owner role');
    }

    return this.repository.updateMemberRole(membership.id, dto.role);
  }

  async removeMember(orgId: string, memberId: string, actorId: string) {
    const membership = await this.repository.findMembership(memberId, orgId);
    if (!membership) {
      throw new NotFoundException('Member not found in this organization');
    }

    if (membership.role === 'OWNER') {
      throw new ForbiddenException('Cannot remove the organization owner');
    }

    if (memberId === actorId) {
      throw new BadRequestException('Cannot remove yourself. Transfer ownership first.');
    }

    await this.repository.removeMember(membership.id);
    this.logger.log(`Member ${memberId} removed from org ${orgId} by ${actorId}`);
  }
}
