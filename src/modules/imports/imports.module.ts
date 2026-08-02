import { Module } from '@nestjs/common';
import { CustomFieldsModule } from '../custom-fields/custom-fields.module';
import { ImportsService } from './imports.service';
import { ImportsController } from './imports.controller';

/** Importação de leads (ex.: base do Kommo em XLSX). Usa CustomFieldsService. */
@Module({
  imports: [CustomFieldsModule],
  controllers: [ImportsController],
  providers: [ImportsService],
})
export class ImportsModule {}
