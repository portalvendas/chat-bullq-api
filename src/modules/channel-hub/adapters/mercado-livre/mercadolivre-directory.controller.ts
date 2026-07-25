import { Controller, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, OrgGuard } from '../../../../common/guards';
import { CurrentOrg } from '../../../../common/decorators';
import { MercadoLivreProductsService } from './mercadolivre.products.service';

/**
 * Ingestores do Mercado Livre pra Central de Conhecimento (import de arquivo de
 * links + varredura de anúncios). Autenticado (JWT + org). O diretório legado
 * (largura→anúncio) foi aposentado — a fonte da verdade agora é KnowledgeItem.
 */
@ApiTags('Integrations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('integrations/mercado-livre/directory')
export class MercadoLivreDirectoryController {
  constructor(private readonly products: MercadoLivreProductsService) {}

  @Post('import-knowledge')
  @ApiOperation({
    summary:
      'Importa o arquivo de links (mesmo formato do diretório) direto na Central de Conhecimento como VARIANT_MAP validado. Aceita { text }.',
  })
  async importKnowledge(
    @CurrentOrg('id') orgId: string,
    @Body() body: { text?: string },
  ) {
    return this.products.importLinksToKnowledge(orgId, body?.text ?? '');
  }

  @Post('scan-variants')
  @ApiOperation({
    summary:
      'Varre TODOS os anúncios ativos do vendedor, extrai a faixa de largura de cada descrição e grava na Central de Conhecimento (VARIANT_MAP, validado). Roda em background.',
  })
  async scanVariants(@CurrentOrg('id') orgId: string) {
    // Fire-and-forget: a varredura lê muitas descrições (pode levar minutos).
    // Os itens aparecem em Conhecimento → Validados conforme concluem.
    this.products
      .scanVariantsToKnowledge(orgId)
      .catch(() => undefined);
    return { started: true };
  }
}
