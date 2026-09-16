import { IsString, IsOptional, IsIn, IsNumber } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Metadado de um anexo de resposta rápida.
 *
 * IMPORTANTE: precisa ser uma CLASSE (não `Record<string, unknown>`) e ser
 * referenciada com `@Type(() => QuickReplyAttachmentDto)` no array. Sem isso,
 * o class-transformer (com `enableImplicitConversion: true`, ligado no
 * ValidationPipe global) NÃO conhece o tipo de cada item e converte cada
 * objeto do array em um array vazio — o payload `[{...}]` vira `[[]]` e o
 * anexo se perde (a mídia nunca chega ao WhatsApp).
 */
export class QuickReplyAttachmentDto {
  @ApiProperty({ description: 'URL pública do anexo.' })
  @IsString()
  url: string;

  @ApiProperty({ enum: ['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT'] })
  @IsIn(['IMAGE', 'VIDEO', 'AUDIO', 'DOCUMENT'])
  type: 'IMAGE' | 'VIDEO' | 'AUDIO' | 'DOCUMENT';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  mimeType?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  fileName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  size?: number;
}
