import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Reenvio em lote de mensagens OUTBOUND que falharam na janela recente.
 * Padrão (sem body) = falhas por pagamento/elegibilidade (131042) nas últimas
 * 24h — o caso do botão no banner de bloqueio de pagamento da Meta.
 */
export class ResendFailedDto {
  @ApiPropertyOptional({
    enum: ['payment', 'all'],
    default: 'payment',
    description:
      "'payment' reenvia só falhas de pagamento/elegibilidade (131042); 'all' reenvia qualquer falha na janela.",
  })
  @IsOptional()
  @IsEnum(['payment', 'all'])
  scope?: 'payment' | 'all';

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 72,
    default: 24,
    description: 'Janela em horas para trás a considerar (1–72). Padrão 24.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(72)
  windowHours?: number;
}
