import { IsString, IsOptional, IsIn, MaxLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateQuickReplyDto {
  @ApiProperty({ description: 'Atalho digitado após "/" (sem a barra).' })
  @IsString()
  @MaxLength(40)
  shortcut: string;

  @ApiProperty({ description: 'Nome/descrição curta.' })
  @IsString()
  @MaxLength(120)
  title: string;

  @ApiProperty({ description: 'Conteúdo. Aceita {{cliente}} e {{vendedor}}.' })
  @IsString()
  content: string;

  @ApiPropertyOptional({
    description:
      'ORG = compartilhada (empresa, todos veem). PERSONAL = só do usuário. Default ORG.',
    enum: ['ORG', 'PERSONAL'],
  })
  @IsOptional()
  @IsIn(['ORG', 'PERSONAL'])
  scope?: 'ORG' | 'PERSONAL';
}
