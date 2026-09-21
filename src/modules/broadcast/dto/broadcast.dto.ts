import { Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { MessageCategory, BudgetPeriod } from '@prisma/client';

export class AudienceFilterDto {
  @IsOptional() @IsString() pipelineId?: string;
  @IsOptional() @IsString() stageId?: string;
  @IsOptional() @IsArray() @IsString({ each: true }) tagIds?: string[];
  @IsOptional() @IsEnum(['ANY', 'ALL'] as any) tagMatch?: 'ANY' | 'ALL';
  @IsOptional() @IsBoolean() hasPedido?: boolean;
  @IsOptional() @IsBoolean() hasOrcamento?: boolean;
  @IsOptional() @IsBoolean() excludePedido?: boolean;
  @IsOptional() @IsInt() @Min(0) noReplyDays?: number;
  @IsOptional() @IsInt() @Min(0) repliedWithinDays?: number;
  @IsOptional() @IsString() from?: string;
  @IsOptional() @IsString() to?: string;
  @IsOptional() @IsBoolean() excludeOptedOut?: boolean;
}

export class PreviewAudienceDto {
  @ValidateNested() @Type(() => AudienceFilterDto) audienceFilter!: AudienceFilterDto;
  @IsOptional() @IsString() cursor?: string;
}

export class CreateBroadcastDto {
  @IsString() @IsNotEmpty() channelId!: string;
  @IsString() @IsNotEmpty() name!: string;
  @IsString() @IsNotEmpty() templateName!: string;
  @IsString() @IsNotEmpty() templateLanguage!: string;
  @IsEnum(MessageCategory) templateCategory!: MessageCategory;
  @IsOptional() @IsObject() variablesMapping?: Record<string, any>;
  @ValidateNested() @Type(() => AudienceFilterDto) audienceFilter!: AudienceFilterDto;
  @IsOptional() @IsString() scheduledAt?: string;
  @IsOptional() @IsInt() @Min(1) @Max(6000) throttlePerMinute?: number;
}

export class EstimateDto {
  @ValidateNested() @Type(() => AudienceFilterDto) audienceFilter!: AudienceFilterDto;
  @IsEnum(MessageCategory) templateCategory!: MessageCategory;
  @IsOptional() @IsString() countryCode?: string;
}

export class SetBudgetDto {
  /** Teto em micros de BRL (string para não perder precisão de BigInt). */
  @IsString() @IsNotEmpty() capMicros!: string;
  @IsOptional() @IsEnum(BudgetPeriod) period?: BudgetPeriod;
}
