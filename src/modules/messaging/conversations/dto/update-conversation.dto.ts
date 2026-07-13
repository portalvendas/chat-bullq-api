import {
  IsOptional,
  IsString,
  IsEnum,
  IsBoolean,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ConversationStatus } from '@prisma/client';

export class UpdateConversationDto {
  @ApiPropertyOptional({ enum: ConversationStatus })
  @IsOptional()
  @IsEnum(ConversationStatus)
  status?: ConversationStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assignedToId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  departmentId?: string;

  /** Apelido interno da conversa — só nós vemos, o cliente não. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  subject?: string;

  /**
   * Override do modo revisão nesta conversa:
   *   null  = segue org.aiReviewMode
   *   true  = força revisão (respostas ficam pendentes de aprovação)
   *   false = envia direto sem revisão
   */
  @ApiPropertyOptional({ type: Boolean, nullable: true })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsBoolean()
  aiReviewMode?: boolean | null;
}
