import { Body, Controller, Delete, Get, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, Roles } from '../../common/decorators';
import { MetaAdsService } from './meta-ads.service';
import { SetMetaAdsDto } from './dto/set-meta-ads.dto';

@ApiTags('Integrations · Meta Ads')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('integrations/meta-ads')
export class MetaAdsController {
  constructor(private readonly service: MetaAdsService) {}

  @Get()
  @ApiOperation({ summary: 'Status da integração Meta Ads da empresa (sem token)' })
  getStatus(@CurrentOrg('id') orgId: string) {
    return this.service.getStatus(orgId);
  }

  @Put()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Configura conta de anúncios + token (valida antes de gravar)' })
  setConfig(@CurrentOrg('id') orgId: string, @Body() dto: SetMetaAdsDto) {
    return this.service.setConfig(orgId, {
      adAccountId: dto.adAccountId,
      accessToken: dto.accessToken,
    });
  }

  @Delete()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Remove a integração Meta Ads da empresa' })
  clear(@CurrentOrg('id') orgId: string) {
    return this.service.clearConfig(orgId);
  }
}
