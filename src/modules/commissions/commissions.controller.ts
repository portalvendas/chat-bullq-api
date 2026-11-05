import { Body, Controller, Delete, Get, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { Response } from 'express';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, Roles } from '../../common/decorators';
import { CommissionsService, type PlanInput } from './commissions.service';

/**
 * Comissões por vendedor. ACESSO EXCLUSIVO DO DONO (OWNER) — nenhum vendedor
 * (nem admin) acessa: regras, metas e valores de comissão são confidenciais.
 */
@ApiTags('Comissões')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Roles(OrgRole.OWNER)
@Controller('commissions')
export class CommissionsController {
  constructor(private readonly service: CommissionsService) {}

  @Get('plans')
  @ApiOperation({ summary: 'Regras de comissão + vendedores do Tiny (opções)' })
  plans(@CurrentOrg('id') org: string) {
    return this.service.listPlans(org);
  }

  @Put('plans')
  @ApiOperation({ summary: 'Cria/atualiza a regra de um vendedor' })
  upsert(@CurrentOrg('id') org: string, @Body() dto: PlanInput) {
    return this.service.upsertPlan(org, dto);
  }

  @Delete('plans/:id')
  @ApiOperation({ summary: 'Remove a regra de um vendedor' })
  remove(@CurrentOrg('id') org: string, @Param('id') id: string) {
    return this.service.deletePlan(org, id);
  }

  @Put('goals')
  @ApiOperation({ summary: 'Meta de um mês específico (vazio = volta à meta padrão)' })
  goal(
    @CurrentOrg('id') org: string,
    @Body() dto: { vendedor: string; month: string; goalAmount?: number | null },
  ) {
    return this.service.setGoal(org, dto);
  }

  @Get('report')
  @ApiOperation({ summary: 'Apuração do mês (month=AAAA-MM)' })
  report(@CurrentOrg('id') org: string, @Query('month') month: string) {
    return this.service.report(org, month);
  }

  @Post('refresh-freight')
  @ApiOperation({ summary: 'Busca no Tiny o frete dos pedidos do mês ainda não apurados' })
  refresh(@CurrentOrg('id') org: string, @Query('month') month: string) {
    return this.service.refreshFreight(org, month);
  }

  @Get('report/export')
  @ApiOperation({ summary: 'Apuração do mês em .xlsx' })
  async export(@CurrentOrg('id') org: string, @Query('month') month: string, @Res() res: Response) {
    const buf = await this.service.exportXlsx(org, month);
    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="comissoes_${month}.xlsx"`,
      'Content-Length': String(buf.length),
    });
    res.end(buf);
  }
}
