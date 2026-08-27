import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsIn, IsOptional } from 'class-validator';

/**
 * Reenvio de convite do dono para uma empresa existente. `ownerEmail` é
 * opcional: se omitido, o backend reaproveita o e-mail do último convite
 * dessa empresa.
 */
export class ResendInvitationDto {
  @ApiPropertyOptional({ description: 'E-mail do convidado (se omitido, reusa o último convite da empresa)' })
  @IsOptional()
  @IsEmail()
  ownerEmail?: string;

  @ApiPropertyOptional({ description: 'Papel do convite', enum: ['OWNER', 'ADMIN', 'AGENT'] })
  @IsOptional()
  @IsIn(['OWNER', 'ADMIN', 'AGENT'])
  role?: 'OWNER' | 'ADMIN' | 'AGENT';
}
