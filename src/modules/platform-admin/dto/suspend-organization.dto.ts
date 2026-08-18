import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

export class SuspendOrganizationDto {
  @ApiPropertyOptional({ description: 'Motivo da suspensão (auditado)' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}
