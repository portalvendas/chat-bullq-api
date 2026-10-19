import { Body, Controller, Get, HttpCode, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, CurrentUser, Roles } from '../../common/decorators';
import { HeartbeatDto } from './dto/heartbeat.dto';
import { ProductivityTrackingService } from './productivity-tracking.service';
import { ProductivityReportService } from './productivity-report.service';

@ApiTags('Productivity')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('productivity')
export class ProductivityController {
  constructor(
    private readonly tracking: ProductivityTrackingService,
    private readonly report: ProductivityReportService,
  ) {}

  /** Qualquer membro: registra a atividade do PRÓPRIO usuário (minuto atual). */
  @Post('heartbeat')
  @HttpCode(204)
  @ApiOperation({ summary: 'Heartbeat de atividade do navegador (~30s)' })
  async heartbeat(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: HeartbeatDto,
  ): Promise<void> {
    await this.tracking.heartbeat(orgId, userId, dto);
  }

  @Get('daily')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Produtividade do dia por vendedor (gestor)' })
  daily(@CurrentOrg('id') orgId: string, @Query('day') day?: string) {
    return this.report.daily(orgId, day);
  }

  @Get('timeline')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Linha do tempo de um vendedor no dia (gestor)' })
  timeline(
    @CurrentOrg('id') orgId: string,
    @Query('userId') userId: string,
    @Query('day') day?: string,
  ) {
    return this.report.timeline(orgId, userId, day);
  }
}
