import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentUser, CurrentOrg, Roles } from '../../common/decorators';
import {
  PermissionGroupsService,
  PermissionGroupInput,
} from './permission-groups.service';
import { RBAC_MODULES } from './permission-groups.constants';

@ApiTags('Permission Groups (RBAC)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('permission-groups')
export class PermissionGroupsController {
  constructor(private readonly service: PermissionGroupsService) {}

  /** Lista de módulos governáveis (para montar o editor de grupo). */
  @Get('modules')
  @ApiOperation({ summary: 'Lista os módulos disponíveis para permissão' })
  modules() {
    return RBAC_MODULES;
  }

  /** Permissões efetivas do usuário logado nesta org (todos os membros). */
  @Get('me/effective')
  @ApiOperation({ summary: 'Permissões efetivas do usuário atual' })
  me(@CurrentUser('id') userId: string, @CurrentOrg('id') orgId: string) {
    return this.service.resolveEffective(userId, orgId);
  }

  @Get()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Lista os grupos de permissão' })
  list(@CurrentOrg('id') orgId: string) {
    return this.service.list(orgId);
  }

  @Post()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Cria um grupo de permissão' })
  create(@CurrentOrg('id') orgId: string, @Body() dto: PermissionGroupInput) {
    return this.service.create(orgId, dto);
  }

  @Patch('assign/:memberId')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Vincula/desvincula um grupo a um membro' })
  assign(
    @CurrentOrg('id') orgId: string,
    @Param('memberId') memberId: string,
    @Body() body: { permissionGroupId: string | null },
  ) {
    return this.service.assign(orgId, memberId, body?.permissionGroupId ?? null);
  }

  @Patch(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Atualiza um grupo de permissão' })
  update(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: PermissionGroupInput,
  ) {
    return this.service.update(id, orgId, dto);
  }

  @Delete(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Remove um grupo de permissão' })
  remove(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.remove(id, orgId);
  }
}
