import { Body, Controller, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CurrentOrg } from '../../common/decorators';
import { JwtAuthGuard, OrgGuard } from '../../common/guards';
import { ImportsService, ImportLeadsDto } from './imports.service';

@ApiTags('Imports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('imports')
export class ImportsController {
  constructor(private readonly service: ImportsService) {}

  @Post('leads')
  @ApiOperation({
    summary:
      'Importa um lote de leads (contato + card) num pipeline. Idempotente (dedupe por telefone/email e kommo_id). Envie em lotes pequenos.',
  })
  importLeads(@CurrentOrg('id') orgId: string, @Body() dto: ImportLeadsDto) {
    return this.service.importLeads(orgId, dto);
  }

  @Post('backfill-dates')
  @ApiOperation({
    summary:
      'Corrige a data dos cards importados do Kommo (usa a "Criado em" guardada no metadata). execute=false = prévia.',
  })
  backfillDates(
    @CurrentOrg('id') orgId: string,
    @Query('execute') execute?: string,
  ) {
    return this.service.backfillImportedDates(
      orgId,
      execute === 'true' || execute === '1',
    );
  }
}
