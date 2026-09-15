import { IsString, IsOptional, IsIn, IsArray, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateQuickReplyDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  shortcut?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  content?: string;

  @ApiPropertyOptional({ type: [Object] })
  @IsOptional()
  @IsArray()
  attachments?: Record<string, unknown>[];

  @ApiPropertyOptional({ enum: ['ORG', 'PERSONAL'] })
  @IsOptional()
  @IsIn(['ORG', 'PERSONAL'])
  scope?: 'ORG' | 'PERSONAL';
}
