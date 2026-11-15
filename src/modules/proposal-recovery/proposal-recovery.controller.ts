import { Controller, Get, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, Roles } from '../../common/decorators';
import { ProposalRecoveryService } from './proposal-recovery.service';

@ApiTags('proposal-recovery')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('proposal-recovery')
export class ProposalRecoveryController {
  constructor(private readonly service: ProposalRecoveryService) {}

  @Get()
  @ApiOperation({ summary: 'Lista recuperações (paginado)' })
  list(
    @CurrentOrg('id') orgId: string,
    @Query('status') status?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    return this.service.list(orgId, {
      status,
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
    });
  }

  @Get('summary')
  @ApiOperation({ summary: 'KPIs da recuperação de orçamentos' })
  summary(@CurrentOrg('id') orgId: string, @Query('days') days?: string) {
    return this.service.summary(orgId, days ? Number(days) : 30);
  }

  @Post('agent')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Cria o agente de recuperação da org (idempotente)' })
  ensureAgent(@CurrentOrg('id') orgId: string) {
    return this.service.ensureAgent(orgId);
  }

  @Post('scan')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Roda a varredura agora (ignora PROPOSAL_RECOVERY_ENABLED)' })
  scan() {
    return this.service.scan({ force: true });
  }
}
