import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString } from 'class-validator';

export class ImpersonateDto {
  @ApiPropertyOptional({
    description:
      'Membro da org a impersonar. Se omitido, auto-seleciona um OWNER (senão ADMIN, senão qualquer membro ativo).',
  })
  @IsOptional()
  @IsString()
  userId?: string;
}
