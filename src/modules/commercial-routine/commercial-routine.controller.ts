import { Body, Controller, Get, Post, Put, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, CurrentUser, Roles } from '../../common/decorators';
import {
  CommercialRoutineService,
  RoutineConfigInput,
} from './commercial-routine.service';

/** Rotina Comercial — checklist diário do vendedor + config (admin). */
@ApiTags('Commercial Routine')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('commercial-routine')
export class CommercialRoutineController {
  constructor(private readonly service: CommercialRoutineService) {}

  @Get('today')
  @ApiOperation({ summary: 'Checklist do dia para o vendedor logado' })
  today(@CurrentOrg('id') orgId: string, @CurrentUser('id') userId: string) {
    return this.service.getToday(orgId, userId);
  }

  @Post('check')
  @ApiOperation({ summary: 'Marca/desmarca um passo como concluído no dia' })
  check(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Body() body: { stepKey: string; done: boolean },
  ) {
    return this.service.toggleCheck(orgId, userId, body.stepKey, !!body.done);
  }

  @Get('leads')
  @ApiOperation({
    summary: 'Leads exatos de um passo/estado (aguardando ação | parado)',
  })
  leads(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Query('stepKey') stepKey?: string,
    @Query('state') state?: string,
  ) {
    const st = state === 'parado' ? 'parado' : 'pending';
    return this.service.listStepLeads(orgId, userId, stepKey || undefined, st);
  }

  @Get('config')
  @ApiOperation({ summary: 'Config da rotina (passos → etapas)' })
  getConfig(@CurrentOrg('id') orgId: string) {
    return this.service.getConfig(orgId);
  }

  @Get('options')
  @ApiOperation({ summary: 'Funis + etapas para configurar o mapeamento' })
  options(@CurrentOrg('id') orgId: string) {
    return this.service.getOptions(orgId);
  }

  @Put('config')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Atualiza mapeamento e ativação da rotina' })
  updateConfig(
    @CurrentOrg('id') orgId: string,
    @Body() dto: RoutineConfigInput,
  ) {
    return this.service.updateConfig(orgId, dto);
  }
}
