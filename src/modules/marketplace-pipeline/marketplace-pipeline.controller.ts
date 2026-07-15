import { Controller, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CurrentOrg } from '../../common/decorators';
import { JwtAuthGuard, OrgGuard } from '../../common/guards';
import {
  MarketplaceConversionService,
  MarketplaceSyncSummary,
} from './marketplace-conversion.service';

/**
 * Trigger manual do sync/conversão do funil de marketplace — útil pra validar
 * sem esperar o cron de 30min. Escopo por org (guard + @CurrentOrg).
 */
@ApiTags('Pipelines')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('pipelines/marketplace')
export class MarketplacePipelineController {
  constructor(private readonly conversion: MarketplaceConversionService) {}

  @Post('sync')
  @ApiOperation({
    summary: 'Roda o sync/conversão do funil de marketplace agora (org atual)',
  })
  async sync(
    @CurrentOrg('id') organizationId: string,
  ): Promise<MarketplaceSyncSummary> {
    return this.conversion.syncOrg(organizationId);
  }
}
