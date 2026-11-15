import {
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

/** Config de agendamento automático da Auditoria de Funil (por empresa). */
export class FunnelAuditConfigDto {
  @ApiPropertyOptional({ description: 'Liga/desliga as execuções automáticas.' })
  @IsOptional()
  @IsBoolean()
  autoEnabled?: boolean;

  @ApiPropertyOptional({
    description: 'Horários HH:MM (fuso São Paulo). Ex.: ["08:30","12:30"].',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/, {
    each: true,
    message: 'cada horário deve estar no formato HH:MM',
  })
  times?: string[];

  @ApiPropertyOptional({
    description: 'Dias da semana (0=Dom .. 6=Sáb). Ex.: [1,2,3,4,5,6].',
    type: [Number],
  })
  @IsOptional()
  @IsArray()
  @IsInt({ each: true })
  @Min(0, { each: true })
  @Max(6, { each: true })
  weekdays?: number[];
}
