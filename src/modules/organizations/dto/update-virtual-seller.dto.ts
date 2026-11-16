import { IsString, IsOptional, IsBoolean, MaxLength } from 'class-validator';

/** Atualização parcial de um vendedor virtual (IA). */
export class UpdateVirtualSellerDto {
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  /** Troca o agente de IA vinculado. Deve ser da mesma org. */
  @IsOptional()
  @IsString()
  aiAgentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2048)
  avatarUrl?: string;

  /** Liga/desliga o vendedor virtual (reflete em user.isActive). */
  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
