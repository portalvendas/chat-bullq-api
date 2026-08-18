import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

export class CreateOrganizationDto {
  @ApiProperty({ description: 'Nome da empresa' })
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  name!: string;

  @ApiProperty({ description: 'E-mail do dono (OWNER) — recebe o convite' })
  @IsEmail()
  ownerEmail!: string;

  @ApiPropertyOptional({ description: 'Plano inicial (opcional)' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  plan?: string;

  @ApiPropertyOptional({ description: 'Slug (gerado do nome se omitido)' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  slug?: string;
}
