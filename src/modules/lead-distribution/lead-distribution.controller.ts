import { Body, Controller, Get, Put, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, Roles } from '../../common/decorators';
import {
  LeadDistributionService,
  LeadDistributionConfigInput,
} from './lead-distribution.service';

/** Orquestrador de leads — config de distribuição ponderada (admin/owner). */
@ApiTags('Lead Distribution')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('lead-distribution')
export class LeadDistributionController {
  constructor(private readonly service: LeadDistributionService) {}

  @Get('config')
  @ApiOperation({ summary: 'Config do orquestrador de leads' })
  getConfig(@CurrentOrg('id') orgId: string) {
    return this.service.getConfig(orgId);
  }

  @Put('config')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Atualiza pesos e ativação da distribuição' })
  updateConfig(
    @CurrentOrg('id') orgId: string,
    @Body() dto: LeadDistributionConfigInput,
  ) {
    return this.service.updateConfig(orgId, dto);
  }
}
