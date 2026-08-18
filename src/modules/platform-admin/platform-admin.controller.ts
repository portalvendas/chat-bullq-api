import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import { JwtAuthGuard, PlatformAdminGuard } from '../../common/guards';
import { CurrentUser } from '../../common/decorators';
import {
  PlatformAdminService,
  type PlatformActor,
} from './platform-admin.service';
import { ListQueryDto } from './dto/list-query.dto';
import { SuspendOrganizationDto } from './dto/suspend-organization.dto';
import { UpdatePlanDto } from './dto/update-plan.dto';
import { ImpersonateDto } from './dto/impersonate.dto';

/**
 * Console de super-admin (plataforma multi-empresa). TODAS as rotas exigem
 * papel SUPER_ADMIN (PlatformAdminGuard) — NÃO usam OrgGuard, pois operam
 * acima das orgs. Mutações são auditadas em PlatformAuditLog.
 */
@ApiTags('Platform Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('platform-admin')
export class PlatformAdminController {
  constructor(private readonly service: PlatformAdminService) {}

  /** Resolve o ator (super-admin + IP) para a trilha de auditoria. */
  private actor(req: Request, userId: string): PlatformActor {
    const fwd = req.headers['x-forwarded-for'];
    const ip =
      (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() || req.ip;
    return { userId, ipAddress: ip };
  }

  @Get('overview')
  @ApiOperation({ summary: 'Métricas gerais da plataforma' })
  overview() {
    return this.service.overview();
  }

  @Get('organizations')
  @ApiOperation({ summary: 'Lista empresas (paginado por cursor + busca)' })
  listOrganizations(@Query() query: ListQueryDto) {
    return this.service.listOrganizations(query);
  }

  @Get('organizations/:id')
  @ApiOperation({ summary: 'Detalhe de uma empresa (sem segredos de canal)' })
  getOrganization(@Param('id') id: string) {
    return this.service.getOrganization(id);
  }

  @Patch('organizations/:id/suspend')
  @ApiOperation({ summary: 'Suspende uma empresa (bloqueia membros)' })
  suspend(
    @Param('id') id: string,
    @Body() dto: SuspendOrganizationDto,
    @CurrentUser('id') userId: string,
    @Req() req: Request,
  ) {
    return this.service.suspendOrganization(id, dto.reason, this.actor(req, userId));
  }

  @Patch('organizations/:id/reactivate')
  @ApiOperation({ summary: 'Reativa uma empresa suspensa' })
  reactivate(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Req() req: Request,
  ) {
    return this.service.reactivateOrganization(id, this.actor(req, userId));
  }

  @Patch('organizations/:id/plan')
  @ApiOperation({ summary: 'Troca o plano de uma empresa' })
  updatePlan(
    @Param('id') id: string,
    @Body() dto: UpdatePlanDto,
    @CurrentUser('id') userId: string,
    @Req() req: Request,
  ) {
    return this.service.updatePlan(id, dto.plan, this.actor(req, userId));
  }

  @Post('impersonate/:organizationId')
  @ApiOperation({
    summary:
      'Emite token de impersonação (agir como membro da org, 30min, auditado)',
  })
  impersonate(
    @Param('organizationId') organizationId: string,
    @Body() dto: ImpersonateDto,
    @CurrentUser('id') userId: string,
    @Req() req: Request,
  ) {
    return this.service.impersonate(
      organizationId,
      this.actor(req, userId),
      dto.userId,
    );
  }

  @Get('users')
  @ApiOperation({ summary: 'Lista usuários da plataforma (paginado + busca)' })
  listUsers(@Query() query: ListQueryDto) {
    return this.service.listUsers(query);
  }

  @Get('audit-logs')
  @ApiOperation({ summary: 'Trilha de auditoria das ações de super-admin' })
  listAuditLogs(
    @Query() query: ListQueryDto,
    @Query('organizationId') organizationId?: string,
  ) {
    return this.service.listAuditLogs({ ...query, organizationId });
  }
}
