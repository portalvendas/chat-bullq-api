import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  UseGuards,
  DefaultValuePipe,
  ParseIntPipe,
  BadRequestException,
  Param,
} from '@nestjs/common';
import { ApiOperation, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg } from '../../../common/decorators';
import { MercadoLivreProductsService } from '../../channel-hub/adapters/mercado-livre/mercadolivre.products.service';

/**
 * Endpoint público (API Key) para o Jarvis consultar produtos ATIVOS do
 * vendedor no Mercado Livre, reusando a integração já conectada.
 */
@ApiTags('Public API · Mercado Livre')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard)
@Controller('public/mercadolivre')
export class PublicMercadoLivreController {
  constructor(private readonly service: MercadoLivreProductsService) {}

  @Get('products')
  @ApiOperation({
    summary: 'Busca produtos ATIVOS do vendedor no Mercado Livre por palavra-chave',
  })
  @ApiQuery({ name: 'q', required: true, description: 'Palavra-chave' })
  @ApiQuery({ name: 'limit', required: false, description: 'Máx. 50 (default 10)' })
  async products(
    @CurrentOrg('id') orgId: string,
    @Query('q') q: string,
    @Query('limit', new DefaultValuePipe(10), ParseIntPipe) limit: number,
  ) {
    if (!q || !q.trim()) {
      throw new BadRequestException('Parâmetro "q" é obrigatório');
    }
    return this.service.search(orgId, q.trim(), limit);
  }

  @Get('products/:id')
  @ApiOperation({
    summary: 'Detalhe de um anúncio (descrição longa + perguntas/respostas do anúncio)',
  })
  async detail(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.getDetail(orgId, id);
  }

  @Post('backfill-items')
  @ApiOperation({
    summary:
      'Backfill: re-enriquece perguntas ML antigas com o anúncio (item). Idempotente.',
  })
  @ApiQuery({
    name: 'channelId',
    required: false,
    description: 'Opcional — default: canal ML ativo mais recente da org',
  })
  async backfillItems(
    @CurrentOrg('id') orgId: string,
    @Query('channelId') channelId?: string,
  ) {
    return this.service.backfillMessageItems(orgId, channelId);
  }

  @Post('reconcile-answers')
  @ApiOperation({
    summary:
      'Reconcilia perguntas: marca como respondidas (e importa a resposta) as que foram respondidas por outro canal no ML. Idempotente.',
  })
  @ApiQuery({ name: 'channelId', required: false })
  async reconcileAnswers(
    @CurrentOrg('id') orgId: string,
    @Query('channelId') channelId?: string,
  ) {
    return this.service.reconcileAnswers(orgId, channelId);
  }

  @Post('directory/import')
  @ApiOperation({
    summary:
      'Importa/atualiza o diretório de organizadores (categoria+largura→anúncio). Aceita { rows } ou { text } (conteúdo cru do .txt). Substitui o diretório da org.',
  })
  async importDirectory(
    @CurrentOrg('id') orgId: string,
    @Body()
    body: {
      rows?: {
        categoria: string;
        larguraCm: number;
        codigo?: string;
        mlb: string;
        url: string;
      }[];
      text?: string;
    },
  ) {
    return this.service.importDirectory(orgId, body ?? {});
  }

  @Get('organizer')
  @ApiOperation({
    summary:
      'Encontra o organizador sob medida certo pela largura da gaveta (cm) e categoria. Usado pela skill encontrar_organizador.',
  })
  @ApiQuery({ name: 'larguraCm', required: true, description: 'Largura da gaveta em cm' })
  @ApiQuery({ name: 'categoria', required: false, description: 'Ex: Colmeia MDF, Talheres MDF, Porta Joia' })
  async organizer(
    @CurrentOrg('id') orgId: string,
    @Query('larguraCm', new DefaultValuePipe(0), ParseIntPipe) larguraCm: number,
    @Query('categoria') categoria?: string,
  ) {
    if (!larguraCm || larguraCm <= 0) {
      throw new BadRequestException('Parâmetro "larguraCm" (cm) é obrigatório');
    }
    return this.service.findOrganizer(orgId, larguraCm, categoria);
  }
}
