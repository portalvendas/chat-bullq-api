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
import {
  KnowledgeStatus,
  KnowledgeType,
} from '@prisma/client';
import { CurrentOrg, CurrentUser } from '../../../common/decorators';
import { JwtAuthGuard, OrgGuard } from '../../../common/guards';
import { KnowledgeService, CreateKnowledgeInput } from './knowledge.service';

/**
 * Central de Conhecimento — CRUD + fila de validação. Escopo por org.
 */
@ApiTags('Knowledge')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('knowledge')
export class KnowledgeController {
  constructor(private readonly service: KnowledgeService) {}

  @Get()
  @ApiOperation({ summary: 'Lista itens de conhecimento (filtros opcionais)' })
  list(
    @CurrentOrg('id') orgId: string,
    @Query('status') status?: KnowledgeStatus,
    @Query('type') type?: KnowledgeType,
    @Query('itemId') itemId?: string,
    @Query('search') search?: string,
  ) {
    return this.service.list(orgId, { status, type, itemId, search });
  }

  @Get('counts')
  @ApiOperation({ summary: 'Contagem por status (badges das abas)' })
  counts(@CurrentOrg('id') orgId: string) {
    return this.service.counts(orgId);
  }

  @Post()
  @ApiOperation({ summary: 'Cria um item (entra como PENDING por padrão)' })
  create(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateKnowledgeInput,
  ) {
    return this.service.create(orgId, { ...dto, createdById: userId });
  }

  @Post(':id/validate')
  @ApiOperation({ summary: 'Valida um item (passa a alimentar as respostas)' })
  validate(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.validate(id, orgId, userId);
  }

  @Post(':id/reject')
  @ApiOperation({ summary: 'Rejeita/arquiva um item' })
  reject(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.reject(id, orgId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edita texto/título/escopo/tipo' })
  update(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body()
    dto: Partial<Pick<CreateKnowledgeInput, 'text' | 'title' | 'itemId' | 'type'>>,
  ) {
    return this.service.update(id, orgId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove um item' })
  remove(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.remove(id, orgId);
  }
}
