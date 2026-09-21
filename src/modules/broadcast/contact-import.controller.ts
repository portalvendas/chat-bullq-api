import { Body, Controller, Get, Param, Post, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation } from '@nestjs/swagger';
import { IsArray, IsOptional, IsString } from 'class-validator';
import { JwtAuthGuard, OrgGuard, ModulePermissionGuard } from '../../common/guards';
import { CurrentOrg, CurrentUser, RequireModule } from '../../common/decorators';
import { ContactImportService, ImportRow } from './contact-import.service';
import { DISPAROS_MODULE } from './broadcast.constants';

class ImportContactsDto {
  @IsOptional() @IsString() fileName?: string;
  @IsArray() rows!: ImportRow[];
  @IsOptional() @IsArray() @IsString({ each: true }) tagIds?: string[];
}

@ApiTags('Disparos')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, ModulePermissionGuard)
@Controller('contacts')
export class ContactImportController {
  constructor(private readonly service: ContactImportService) {}

  @Post('import')
  @RequireModule(DISPAROS_MODULE, 'edit')
  @ApiOperation({ summary: 'Importa contatos (linhas do CSV/XLSX) + tags' })
  async importContacts(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: ImportContactsDto,
  ) {
    return this.service.enqueue(orgId, userId, dto);
  }

  @Get('imports/:id')
  @RequireModule(DISPAROS_MODULE, 'view')
  @ApiOperation({ summary: 'Status de uma importação' })
  async getImport(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.getImport(orgId, id);
  }
}
