import {
  Controller,
  Get,
  Patch,
  Put,
  Post,
  Delete,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { OrganizationsService } from './organizations.service';
import { UpdateOrganizationDto } from './dto/update-organization.dto';
import { InviteMemberDto } from './dto/invite-member.dto';
import { SetAiKeyDto } from './dto/set-ai-key.dto';
import { LlmKeyService } from '../ai-agents/llm/llm-key.service';
import { UpdateMemberRoleDto } from './dto/update-member-role.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, CurrentOrg, Roles, Public } from '../../common/decorators';

@ApiTags('Organizations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('organizations')
export class OrganizationsController {
  constructor(
    private readonly service: OrganizationsService,
    private readonly llmKey: LlmKeyService,
  ) {}

  @Get('current')
  @ApiOperation({ summary: 'Get current organization details' })
  getCurrent(@CurrentOrg('id') orgId: string) {
    return this.service.getOrganization(orgId);
  }

  @Patch('current')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Update current organization' })
  update(@CurrentOrg('id') orgId: string, @Body() dto: UpdateOrganizationDto) {
    return this.service.updateOrganization(orgId, dto);
  }

  @Get('loss-reasons')
  @ApiOperation({ summary: 'Lista os motivos de perda configurados' })
  getLossReasons(@CurrentOrg('id') orgId: string) {
    return this.service.getLossReasons(orgId);
  }

  @Put('loss-reasons')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Define os motivos de perda' })
  setLossReasons(
    @CurrentOrg('id') orgId: string,
    @Body() body: { reasons: string[] },
  ) {
    return this.service.setLossReasons(orgId, body?.reasons ?? []);
  }

  // ─── Chave da API do Claude (BYOK, por empresa) ─────────────────
  @Get('current/ai-key')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Status da chave do Claude desta empresa (mascarado)' })
  getAiKey(@CurrentOrg('id') orgId: string) {
    return this.llmKey.getStatus(orgId);
  }

  @Put('current/ai-key')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Configura a chave do Claude (valida antes de gravar)' })
  setAiKey(@CurrentOrg('id') orgId: string, @Body() dto: SetAiKeyDto) {
    return this.llmKey.setKey(orgId, dto.apiKey, { test: dto.test });
  }

  @Delete('current/ai-key')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Remove a chave do Claude desta empresa' })
  clearAiKey(@CurrentOrg('id') orgId: string) {
    return this.llmKey.clearKey(orgId);
  }

  @Get('members')
  @ApiOperation({ summary: 'List members of current organization' })
  getMembers(@CurrentOrg('id') orgId: string) {
    return this.service.getMembers(orgId);
  }

  @Post('members/invite')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Invite a member to the organization' })
  invite(
    @CurrentOrg('id') orgId: string,
    @Body() dto: InviteMemberDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.inviteMember(orgId, dto, userId);
  }

  @Get('invitations')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'List invitations for current organization' })
  getInvitations(@CurrentOrg('id') orgId: string) {
    return this.service.getInvitations(orgId);
  }

  @Delete('invitations/:invitationId')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Revoke a pending invitation' })
  revokeInvitation(
    @CurrentOrg('id') orgId: string,
    @Param('invitationId') invitationId: string,
  ) {
    return this.service.revokeInvitation(orgId, invitationId);
  }

  @Get('invitations/validate')
  @Public()
  @ApiOperation({ summary: 'Validate an invitation token (public)' })
  validateInvitation(@Query('token') token: string) {
    return this.service.validateInvitation(token);
  }

  @Patch('members/:memberId/role')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Change member role' })
  updateRole(
    @CurrentOrg('id') orgId: string,
    @CurrentOrg('userRole') actorRole: OrgRole,
    @Param('memberId') memberId: string,
    @Body() dto: UpdateMemberRoleDto,
  ) {
    return this.service.updateMemberRole(orgId, memberId, dto, actorRole);
  }

  @Delete('members/:memberId')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Remove a member from the organization' })
  removeMember(
    @CurrentOrg('id') orgId: string,
    @Param('memberId') memberId: string,
    @CurrentUser('id') actorId: string,
  ) {
    return this.service.removeMember(orgId, memberId, actorId);
  }
}
