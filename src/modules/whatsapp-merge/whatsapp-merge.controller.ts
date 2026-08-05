import { Controller, Post, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { WhatsappMergeService } from './whatsapp-merge.service';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg } from '../../common/decorators';

@ApiTags('WhatsApp Merge (LID dedup)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('whatsapp-merge')
export class WhatsappMergeController {
  constructor(private readonly service: WhatsappMergeService) {}

  @Post('lids')
  @ApiOperation({
    summary:
      'Une contatos/conversas/cards duplicados por LID no WhatsApp Z-API. execute=false (padrão) = prévia; execute=true = aplica.',
  })
  run(
    @CurrentOrg('id') orgId: string,
    @Query('execute') execute?: string,
  ) {
    return this.service.run(orgId, execute === 'true' || execute === '1');
  }
}
