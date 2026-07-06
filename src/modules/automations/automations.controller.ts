import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg, CurrentUser, Roles } from '../../common/decorators';
import { AutomationsService } from './automations.service';
import {
  CreateAutomationDto,
  DryRunDto,
  UpdateAutomationDto,
} from './dto/automation.dto';

@ApiTags('Automations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('automations')
export class AutomationsController {
  constructor(private readonly service: AutomationsService) {}

  @Get('meta')
  @ApiOperation({
    summary: 'Form scaffolding (triggers, fields, operators, actions)',
  })
  meta() {
    return this.service.getMeta();
  }

  @Get()
  @ApiOperation({ summary: 'List automations' })
  list(@CurrentOrg('id') orgId: string) {
    return this.service.list(orgId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get one automation' })
  findOne(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.findOne(id, orgId);
  }

  @Post()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Create automation' })
  create(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateAutomationDto,
  ) {
    return this.service.create(orgId, userId, dto);
  }

  @Patch(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Update automation' })
  update(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: UpdateAutomationDto,
  ) {
    return this.service.update(id, orgId, dto);
  }

  @Post(':id/toggle')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Enable/disable automation' })
  toggle(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Query('enabled') enabled: string,
  ) {
    return this.service.toggle(id, orgId, enabled === 'true');
  }

  @Delete(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Soft delete automation' })
  remove(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.remove(id, orgId);
  }

  @Post(':id/dry-run')
  @ApiOperation({
    summary: 'Test conditions against a mock payload (no execution)',
  })
  dryRun(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: DryRunDto,
  ) {
    return this.service.dryRun(id, orgId, dto.payload);
  }
}
