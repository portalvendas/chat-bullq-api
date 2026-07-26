import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentOrg } from '../../common/decorators';
import { JwtAuthGuard, OrgGuard } from '../../common/guards';
import { CadencesService, CadenceInput } from './cadences.service';

@ApiTags('Cadences')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('cadences')
export class CadencesController {
  constructor(private readonly service: CadencesService) {}

  @Get()
  @ApiOperation({ summary: 'Lista as cadências da org' })
  list(@CurrentOrg('id') orgId: string) {
    return this.service.list(orgId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Detalhe de uma cadência' })
  get(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.get(id, orgId);
  }

  @Post()
  @ApiOperation({ summary: 'Cria uma cadência' })
  create(@CurrentOrg('id') orgId: string, @Body() dto: CadenceInput) {
    return this.service.create(orgId, dto);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Edita uma cadência' })
  update(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: CadenceInput,
  ) {
    return this.service.update(id, orgId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove uma cadência' })
  remove(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.remove(id, orgId);
  }

  @Post(':id/start')
  @ApiOperation({ summary: 'Inicia a cadência numa conversa' })
  start(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() body: { conversationId: string },
  ) {
    return this.service.start(id, orgId, body?.conversationId);
  }

  @Post('import-kommo')
  @ApiOperation({ summary: 'Importa bots exportados do Kommo como Salesbots' })
  importKommo(
    @CurrentOrg('id') orgId: string,
    @Body() body: { files: Array<{ name: string; model: any }> },
  ) {
    return this.service.importKommo(orgId, body?.files ?? []);
  }
}
