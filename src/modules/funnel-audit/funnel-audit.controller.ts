import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, CurrentUser, Roles } from '../../common/decorators';
import { FunnelAuditService } from './funnel-audit.service';

/** Auditoria de Funil — só admin/owner. Sugestões de mudança de etapa por card. */
@ApiTags('Funnel Audit')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Roles(OrgRole.OWNER, OrgRole.ADMIN)
@Controller('funnel-audit')
export class FunnelAuditController {
  constructor(private readonly service: FunnelAuditService) {}

  @Post('run')
  @ApiOperation({ summary: 'Dispara uma auditoria de funil (background)' })
  run(@CurrentOrg('id') orgId: string, @CurrentUser('id') userId: string) {
    return this.service.startRun(orgId, userId);
  }

  @Get('latest')
  @ApiOperation({ summary: 'Status do último run de auditoria' })
  latest(@CurrentOrg('id') orgId: string) {
    return this.service.getLatestRun(orgId);
  }

  @Get('suggestions')
  @ApiOperation({ summary: 'Sugestões (paginadas) do run mais recente ou de um runId' })
  suggestions(
    @CurrentOrg('id') orgId: string,
    @Query('runId') runId?: string,
    @Query('status') status?: string,
    @Query('pipelineId') pipelineId?: string,
    @Query('page') page = '1',
    @Query('limit') limit = '50',
  ) {
    return this.service.listSuggestions(orgId, {
      runId,
      status,
      pipelineId,
      page: Number(page) || 1,
      limit: Number(limit) || 50,
    });
  }

  @Post('suggestions/:id/apply')
  @ApiOperation({ summary: 'Aplica a sugestão (move o card para a etapa sugerida)' })
  apply(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.applySuggestion(orgId, id);
  }

  @Post('suggestions/:id/dismiss')
  @ApiOperation({ summary: 'Ignora a sugestão' })
  dismiss(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.dismissSuggestion(orgId, id);
  }
}
