import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg } from '../../../common/decorators';
import { PublicLeadsService } from '../services/public-leads.service';

/**
 * Intake público de leads via API Key (ex.: node do n8n vindo da Landing
 * Page). Aceita qualquer payload — extrai nome/telefone/email e captura todo
 * o tracking (UTMs, click IDs, etc.) — e cria contato + card na entrada do
 * funil. Objetivo: paridade com o Kommo e nenhum lead perdido.
 */
@ApiTags('Public API · Leads')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard)
@Controller('public/leads')
export class PublicLeadsController {
  constructor(private readonly service: PublicLeadsService) {}

  @Post()
  @ApiOperation({
    summary:
      'Recebe um lead (nome/telefone/email + tracking) e cria contato + card na entrada do funil. Idempotente por contato.',
  })
  async ingest(
    @CurrentOrg('id') orgId: string,
    @Body() body: Record<string, any>,
  ) {
    return this.service.ingest(orgId, body ?? {});
  }
}
