import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AutomationTrigger } from '@prisma/client';
import {
  Allow,
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class CreateAutomationDto {
  @ApiProperty({ example: 'Atribuir lead VIP ao João' })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ enum: AutomationTrigger })
  @IsEnum(AutomationTrigger)
  trigger!: AutomationTrigger;

  // Loose typing for conditions/actions — they're validated by the
  // AutomationsValidator rather than class-validator (the structure is
  // dynamic per trigger and per action type, so a static decorator
  // schema would either be over-permissive or unmaintainable).
  // @Allow() is needed because main.ts uses forbidNonWhitelisted=true,
  // which would otherwise drop these undecorated properties before they
  // reach the controller.
  @ApiPropertyOptional({ description: '2-level OR>AND group structure' })
  @IsOptional()
  @Allow()
  conditions?: unknown;

  @ApiProperty({ description: 'ordered array of action definitions' })
  @Allow()
  actions!: unknown;

  @ApiPropertyOptional({ default: false })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  priority?: number;

  @ApiPropertyOptional({ default: 10, description: 'per-conv per-min cap' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  rateLimitPerMinute?: number;
}

export class UpdateAutomationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ enum: AutomationTrigger })
  @IsOptional()
  @IsEnum(AutomationTrigger)
  trigger?: AutomationTrigger;

  @ApiPropertyOptional()
  @IsOptional()
  @Allow()
  conditions?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  @Allow()
  actions?: unknown;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  priority?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(120)
  rateLimitPerMinute?: number;
}

export class DryRunDto {
  @ApiProperty({
    description:
      'Mock event payload to evaluate against this automation. Shape must match the automation trigger.',
  })
  @Allow()
  payload!: Record<string, unknown>;
}
