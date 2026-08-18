import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** Query padrão de listagem paginada (cursor) + busca textual. */
export class ListQueryDto {
  @ApiPropertyOptional({ description: 'Cursor = id do último item da página anterior' })
  @IsOptional()
  @IsString()
  cursor?: string;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ description: 'Busca por nome/slug/email' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  search?: string;
}
