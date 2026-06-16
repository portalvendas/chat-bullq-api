import { IsString, IsOptional, Matches } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateTagDto {
  @ApiProperty()
  @IsString()
  name: string;

  @ApiPropertyOptional({ default: '#6B7280' })
  @IsOptional()
  @IsString()
  @Matches(/^#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})$/, {
    message: 'color must be a valid hex color (e.g. #6B7280)',
  })
  color?: string;
}
