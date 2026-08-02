import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { CustomFieldEntity } from '@prisma/client';
import { CurrentOrg } from '../../common/decorators';
import { JwtAuthGuard, OrgGuard } from '../../common/guards';
import { CustomFieldsService, CustomFieldInput } from './custom-fields.service';

@ApiTags('Custom Fields')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('custom-fields')
export class CustomFieldsController {
  constructor(private readonly service: CustomFieldsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista campos personalizados da org' })
  list(
    @CurrentOrg('id') orgId: string,
    @Query('entity') entity?: CustomFieldEntity,
  ) {
    return this.service.list(orgId, entity);
  }

  @Post()
  @ApiOperation({ summary: 'Cria um campo personalizado' })
  create(@CurrentOrg('id') orgId: string, @Body() dto: CustomFieldInput) {
    return this.service.create(orgId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Remove um campo personalizado' })
  remove(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.remove(orgId, id);
  }
}
