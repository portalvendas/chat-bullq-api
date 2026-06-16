import { Body, Controller, Delete, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { ApiKeysService } from './api-keys.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, CurrentUser, Roles } from '../../common/decorators';

@ApiTags('API Keys')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly service: ApiKeysService) {}

  @Post()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Create a new API key (rawKey returned ONLY once)' })
  create(
    @Body() dto: CreateApiKeyDto,
    @CurrentUser('id') userId: string,
    @CurrentOrg('id') organizationId: string,
  ) {
    return this.service.create(dto.name, userId, organizationId, dto.expiresAt);
  }

  @Get()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'List all API keys of the current organization (no rawKey)' })
  list(@CurrentOrg('id') organizationId: string) {
    return this.service.findAll(organizationId);
  }

  @Delete(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Revoke an API key' })
  revoke(@Param('id') id: string, @CurrentOrg('id') organizationId: string) {
    return this.service.revoke(id, organizationId);
  }
}
