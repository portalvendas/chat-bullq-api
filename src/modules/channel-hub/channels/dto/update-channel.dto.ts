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

  /**
   * Trava de follow-up por canal:
   *   false (default) = o canal dispara follow-up (cadências/Salesbots) normal.
   *   true            = este número NÃO dispara follow-up — usado p/ WhatsApp
   *                     Business (QR/Z-API) com restrição de disparo automático.
   */
  @ApiPropertyOptional({
    type: Boolean,
    description:
      'true = bloqueia disparo de follow-up (cadências/Salesbots) por este canal',
  })
  @IsOptional()
  @IsBoolean()
  followUpBlocked?: boolean;

  /**
   * Vendedor DONO deste número. Leads que entram por este canal (inbound ou
   * LP com numero_whatsapp = este número) são atribuídos a ele na distribuição,
   * antes do sorteio ponderado. null/'' = sem dono (cai no sorteio).
   */
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'userId do vendedor dono do número; null = sem dono',
  })
  @IsOptional()
  @IsString()
  ownerUserId?: string | null;
}
