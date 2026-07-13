import {
  IsString,
  IsOptional,
  IsObject,
  IsBoolean,
  IsIn,
  IsInt,
  Min,
  ValidateIf,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class UpdateChannelDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsObject()
  config?: Record<string, any>;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  webhookSecret?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /**
   * Tri-state override de IA por canal:
   *   null  = segue org.aiEnabled
   *   true  = força IA ON nesse canal
   *   false = força IA OFF nesse canal
   * Permite o operador desligar a IA num canal específico sem mexer no toggle global.
   */
  @ApiPropertyOptional({
    type: Boolean,
    nullable: true,
    description:
      'Override por canal: null=segue org, true=força ON, false=força OFF',
  })
  @IsOptional()
  @IsBoolean()
  aiEnabled?: boolean | null;

  /**
   * Visibility scope:
   * - ORG     → todos os membros da org enxergam (default).
   * - PRIVATE → só membros com grant explícito enxergam, mesmo OWNER/ADMIN.
   *   Ao virar PRIVATE, quem está fazendo a request ganha grant automático
   *   pra não se trancar fora.
   */
  @ApiPropertyOptional({ enum: ['ORG', 'PRIVATE'] })
  @IsOptional()
  @IsIn(['ORG', 'PRIVATE'])
  visibility?: 'ORG' | 'PRIVATE';

  /**
   * Janela de debounce (segundos) antes da IA responder. Nessa janela,
   * novas mensagens do mesmo cliente na conversa são agrupadas numa
   * resposta só (cada mensagem reinicia a contagem).
   *   null = usa o default do sistema (10s).
   */
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'Debounce por canal em segundos; null=default do sistema (10s)',
  })
  @IsOptional()
  @ValidateIf((_, v) => v !== null)
  @IsInt()
  @Min(0)
  aiDebounceSeconds?: number | null;
}
