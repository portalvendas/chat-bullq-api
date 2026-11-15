import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

/** Corpo do POST /proposal-recovery/test/:conversationId (tudo opcional). */
export class TestKickoffDto {
  /** Orçamento específico (TinyDocument.id). Ausente = mais recente do contato. */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  tinyDocumentId?: string;

  /** Apaga recuperação anterior (não-WON) dessa proposta pra repetir o teste. */
  @IsOptional()
  @IsBoolean()
  reset?: boolean;
}
