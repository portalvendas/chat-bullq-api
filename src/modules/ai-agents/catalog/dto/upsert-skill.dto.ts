import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A Skill is the LLM-callable function. It binds to a Tool (provider) and
 * carries the per-call invocation: HTTP path/method/body, or SQL query +
 * params. The `name` is what the LLM sees as the function name.
 */
export class UpsertSkillDto {
  @ApiProperty({ example: 'resetPassword' })
  @IsString()
  @MinLength(2)
  @MaxLength(60)
  @Matches(/^[a-zA-Z][a-zA-Z0-9_]*$/, {
    message:
      'Skill name must start with a letter and contain only letters, digits or underscores (the LLM uses this as a function name).',
  })
  name!: string;

  @ApiProperty()
  @IsString()
  @MinLength(10)
  description!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  category?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  promptInstructions?: string;

  @ApiProperty({
    enum: ['HTTP', 'SQL'],
    description:
      'HTTP = invoca uma rota da Tool HTTP. SQL = roda query na Tool SQL.',
  })
  @IsIn(['HTTP', 'SQL'])
  source!: 'HTTP' | 'SQL';

  @ApiProperty({
    description: 'JSON Schema do input que o LLM vai passar.',
  })
  @IsObject()
  parameters!: Record<string, unknown>;

  @ApiProperty({ description: 'ID da Tool (provider) que essa skill usa.' })
  @IsString()
  toolId!: string;

  // ── HTTP invocation (quando source=HTTP) ────────────────────────

  @ApiPropertyOptional({ example: 'POST' })
  @IsOptional()
  @IsString()
  @Matches(/^(GET|POST|PUT|PATCH|DELETE)$/i)
  httpMethod?: string;

  @ApiPropertyOptional({
    example: '/admin/actions/reset-password',
    description: 'Path relativo ao baseUrl da tool',
  })
  @IsOptional()
  @IsString()
  httpPath?: string;

  @ApiPropertyOptional({
    description:
      'Headers EXTRAS específicos dessa skill (somados aos da tool).',
  })
  @IsOptional()
  @IsObject()
  httpHeadersExtra?: Record<string, string>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  httpBodyTemplate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  responseMap?: Record<string, string>;

  // ── SQL invocation (quando source=SQL) ──────────────────────────

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  sqlQuery?: string;

  @ApiPropertyOptional({
    description: '[{name, source: "input.x"|"ctx.x"|"literal:..."}]',
  })
  @IsOptional()
  @IsArray()
  sqlParamMap?: Array<{ name?: string; source: string }>;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  sqlReadOnly?: boolean;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(500)
  sqlMaxRows?: number;

  @ApiPropertyOptional({ default: 15000 })
  @IsOptional()
  @IsInt()
  @Min(500)
  @Max(60000)
  timeoutMs?: number;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  changeNote?: string;
}
