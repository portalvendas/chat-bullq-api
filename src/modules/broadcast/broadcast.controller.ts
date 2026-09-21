import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { JwtAuthGuard, OrgGuard, ModulePermissionGuard } from '../../common/guards';
import { CurrentOrg, CurrentUser, RequireModule } from '../../common/decorators';
import { PrismaService } from '../../database/prisma.service';
import { BroadcastService } from './broadcast.service';
import { BroadcastEstimateService } from './estimate.service';
import { BroadcastPricingService } from './pricing.service';
import { BroadcastBudgetService } from './budget.service';
import { serializeBigInt } from './money.util';
import { DISPAROS_MODULE } from './broadcast.constants';
import { CreateBroadcastDto, EstimateDto, SetBudgetDto } from './dto/broadcast.dto';

/** Config/leitura de disparos (rate card, templates, teto, estimativa). */
@ApiTags('Disparos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, ModulePermissionGuard)
@Controller('broadcast')
export class BroadcastConfigController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly pricing: BroadcastPricingService,
    private readonly budget: BroadcastBudgetService,
    private readonly estimateSvc: BroadcastEstimateService,
  ) {}

  @Get('pricing')
  @RequireModule(DISPAROS_MODULE, 'view')
  @ApiOperation({ summary: 'Rate card vigente (custo por mensagem)' })
  async pricing_(@Query('country') country = 'BR') {
    return serializeBigInt(await this.pricing.currentRateCard(country));
  }

  @Get('templates')
  @RequireModule(DISPAROS_MODULE, 'view')
  @ApiOperation({ summary: 'Templates APROVADOS da org (para o disparo)' })
  async templates(
    @CurrentOrg('id') orgId: string,
    @Query('channelId') channelId?: string,
  ) {
    const rows = await this.prisma.whatsappTemplate.findMany({
      where: {
        organizationId: orgId,
        status: 'APPROVED',
        ...(channelId ? { channelId } : {}),
      },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        language: true,
        category: true,
        bodyText: true,
        components: true,
      },
    });
    return rows;
  }

  @Get('budget')
  @RequireModule(DISPAROS_MODULE, 'view')
  @ApiOperation({ summary: 'Uso do teto de disparos' })
  async getBudget(@CurrentOrg('id') orgId: string) {
    return serializeBigInt(await this.budget.getUsage(orgId));
  }

  @Put('budget')
  @RequireModule(DISPAROS_MODULE, 'edit')
  @ApiOperation({ summary: 'Define o teto de disparos da empresa' })
  async setBudget(@CurrentOrg('id') orgId: string, @Body() dto: SetBudgetDto) {
    const cap = BigInt(dto.capMicros);
    await this.budget.setCap(orgId, cap, dto.period ?? 'MONTHLY');
    return serializeBigInt(await this.budget.getUsage(orgId));
  }

  @Post('estimate')
  @RequireModule(DISPAROS_MODULE, 'view')
  @ApiOperation({ summary: 'Estimativa ao vivo (sem criar disparo)' })
  async estimate(@CurrentOrg('id') orgId: string, @Body() dto: EstimateDto) {
    const res = await this.estimateSvc.estimate({
      organizationId: orgId,
      filter: dto.audienceFilter,
      templateCategory: dto.templateCategory,
      countryCode: dto.countryCode,
    });
    return serializeBigInt(res);
  }
}

/** Campanhas de disparo (CRUD + ações). */
@ApiTags('Disparos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, ModulePermissionGuard)
@Controller('broadcasts')
export class BroadcastController {
  constructor(
    private readonly service: BroadcastService,
    private readonly estimateSvc: BroadcastEstimateService,
  ) {}

  @Post()
  @RequireModule(DISPAROS_MODULE, 'edit')
  @ApiOperation({ summary: 'Cria um disparo (DRAFT)' })
  async create(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateBroadcastDto,
  ) {
    return serializeBigInt(await this.service.create(orgId, userId, dto));
  }

  @Get()
  @RequireModule(DISPAROS_MODULE, 'view')
  async list(
    @CurrentOrg('id') orgId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return serializeBigInt(
      await this.service.list(orgId, { cursor, limit: limit ? +limit : undefined }),
    );
  }

  @Get(':id')
  @RequireModule(DISPAROS_MODULE, 'view')
  async getOne(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return serializeBigInt(await this.service.getOne(orgId, id));
  }

  @Get(':id/recipients')
  @RequireModule(DISPAROS_MODULE, 'view')
  async recipients(
    @CurrentOrg('id') orgId: string,
    @Param('id') id: string,
    @Query('status') status?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return serializeBigInt(
      await this.service.listRecipients(orgId, id, {
        status,
        cursor,
        limit: limit ? +limit : undefined,
      }),
    );
  }

  @Post(':id/estimate')
  @RequireModule(DISPAROS_MODULE, 'view')
  async estimate(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    const b = await this.service.getOne(orgId, id);
    const res = await this.estimateSvc.estimate({
      organizationId: orgId,
      filter: b.audienceFilter as any,
      templateCategory: b.templateCategory,
    });
    return serializeBigInt(res);
  }

  @Post(':id/start')
  @RequireModule(DISPAROS_MODULE, 'edit')
  async start(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return serializeBigInt(await this.service.start(orgId, id));
  }

  @Post(':id/pause')
  @RequireModule(DISPAROS_MODULE, 'edit')
  async pause(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return serializeBigInt(await this.service.pause(orgId, id));
  }

  @Post(':id/resume')
  @RequireModule(DISPAROS_MODULE, 'edit')
  async resume(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return serializeBigInt(await this.service.resume(orgId, id));
  }

  @Post(':id/cancel')
  @RequireModule(DISPAROS_MODULE, 'edit')
  async cancel(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return serializeBigInt(await this.service.cancel(orgId, id));
  }
}
