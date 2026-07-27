import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentOrg } from '../../common/decorators';
import { JwtAuthGuard, OrgGuard } from '../../common/guards';
import {
  WhatsappTemplatesService,
  TemplateInput,
} from './whatsapp-templates.service';

@ApiTags('WhatsApp Templates')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('whatsapp-templates')
export class WhatsappTemplatesController {
  constructor(private readonly service: WhatsappTemplatesService) {}

  @Get()
  @ApiOperation({ summary: 'Lista modelos (paginado)' })
  list(
    @CurrentOrg('id') orgId: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
    @Query('search') search?: string,
    @Query('status') status?: string,
    @Query('waba') waba?: string,
  ) {
    return this.service.list(orgId, {
      page: page ? Number(page) : undefined,
      pageSize: pageSize ? Number(pageSize) : undefined,
      search,
      status,
      waba,
    });
  }

  @Get('summary')
  @ApiOperation({ summary: 'Resumo por status' })
  summary(@CurrentOrg('id') orgId: string) {
    return this.service.summary(orgId);
  }

  @Post()
  @ApiOperation({ summary: 'Cria um modelo manual' })
  create(@CurrentOrg('id') orgId: string, @Body() dto: TemplateInput) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edita um modelo' })
  update(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: Partial<TemplateInput>,
  ) {
    return this.service.update(id, orgId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove um modelo' })
  remove(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.remove(id, orgId);
  }

  @Post('seed')
  @ApiOperation({ summary: 'Popula com os templates aprovados (seed)' })
  seed(@CurrentOrg('id') orgId: string) {
    return this.service.seedApproved(orgId);
  }

  @Post('sync')
  @ApiOperation({ summary: 'Sincroniza com a Meta (Graph API)' })
  sync(@CurrentOrg('id') orgId: string) {
    return this.service.syncFromMeta(orgId);
  }

  @Get('health')
  @ApiOperation({ summary: 'Quality rating + limite dos números WhatsApp' })
  health(@CurrentOrg('id') orgId: string) {
    return this.service.channelHealth(orgId);
  }

  @Post(':id/submit')
  @ApiOperation({ summary: 'Submete o template à Meta para aprovação' })
  submit(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.submitToMeta(id, orgId);
  }
}
