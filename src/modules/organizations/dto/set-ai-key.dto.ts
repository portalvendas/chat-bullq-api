import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class SetAiKeyDto {
  @ApiProperty({ description: 'Chave da API da Anthropic (Claude), sk-ant-...' })
  @IsString()
  @MinLength(10)
  apiKey!: string;

  @ApiPropertyOptional({
    description:
      'Validar a chave com a Anthropic antes de gravar (default true).',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  test?: boolean;
}
