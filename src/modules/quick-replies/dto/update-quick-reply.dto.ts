import { IsString, IsOptional, IsIn, IsArray, MaxLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { QuickReplyAttachmentDto } from './quick-reply-attachment.dto';

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

  @ApiPropertyOptional({ description: 'TIPO/categoria livre.' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  category?: string;

  @ApiPropertyOptional({ type: [QuickReplyAttachmentDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => QuickReplyAttachmentDto)
  attachments?: QuickReplyAttachmentDto[];

  @ApiPropertyOptional({ enum: ['ORG', 'PERSONAL'] })
  @IsOptional()
  @IsIn(['ORG', 'PERSONAL'])
  scope?: 'ORG' | 'PERSONAL';
}
