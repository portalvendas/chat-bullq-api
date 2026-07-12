import {
  Controller,
  Get,
  Query,
  UseGuards,
  DefaultValuePipe,
  ParseIntPipe,
  BadRequestException,
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
}
