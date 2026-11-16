import { IsString, IsNotEmpty, IsOptional, MaxLength } from 'class-validator';

/** Payload de criação de um vendedor virtual (IA). */
export class CreateVirtualSellerDto {
  /** Nome exibido do vendedor virtual (aparece na distribuição e nas conversas). */
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  /** Agente de IA (AiAgent) que atua como este vendedor. Deve ser da mesma org. */
  @IsString()
  @IsNotEmpty()
  aiAgentId: string;

  /** Avatar opcional. */
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  avatarUrl?: string;
}
