import { Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg } from '../../common/decorators';
import { LeadEnrichmentService } from './lead-enrichment.service';

@ApiTags('Lead Enrichment')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('lead-enrichment')
export class LeadEnrichmentController {
  constructor(private readonly service: LeadEnrichmentService) {}

  @Post('conversations/:conversationId/extract')
  @ApiOperation({
    summary:
      'Extrai e enriquece os dados de cadastro do lead a partir das mensagens da conversa',
  })
  extract(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.service.enrichFromConversation(orgId, conversationId);
  }

  @Get('conversations/:conversationId/cadastro')
  @ApiOperation({ summary: 'Dados de cadastro já enriquecidos do lead da conversa' })
  cadastro(
    @CurrentOrg('id') orgId: string,
    @Param('conversationId') conversationId: string,
  ) {
    return this.service.getCadastroByConversation(orgId, conversationId);
  }
}
