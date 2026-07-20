import { Controller, Get, Post, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { JwtAuthGuard, OrgGuard } from '../../../../common/guards';
import { CurrentOrg } from '../../../../common/decorators';
import { MercadoLivreProductsService } from './mercadolivre.products.service';

/**
 * Gestão do diretório de organizadores (largura→anúncio) pela UI do BullQ.
 * Autenticado (JWT + org do usuário). O operador cola/sobe a lista e importa
 * direto — sem curl/JSON. Mesmo parser server-side do endpoint público.
 */
@ApiTags('Integrations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('integrations/mercado-livre/directory')
export class MercadoLivreDirectoryController {
  constructor(private readonly products: MercadoLivreProductsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista o diretório de organizadores da org (agrupado)' })
  async list(@CurrentOrg('id') orgId: string) {
    return this.products.listDirectory(orgId);
  }

  @Post('import')
  @ApiOperation({
    summary:
      'Importa/substitui o diretório. Aceita { text } (conteúdo colado do arquivo) ou { rows }.',
  })
  async import(
    @CurrentOrg('id') orgId: string,
    @Body() body: { text?: string; rows?: any[] },
  ) {
    return this.products.importDirectory(orgId, body ?? {});
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
