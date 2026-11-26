import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString } from 'class-validator';

/** Executa a transferência dos leads (cards) selecionados para um vendedor. */
export class LeadTransferDto {
  /** Cards (leads) escolhidos na prévia. */
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(1000)
  @IsString({ each: true })
  cardIds: string[];

  /** Vendedor que vai assumir os leads. */
  @IsString()
  toUserId: string;

  /**
   * Vendedor de origem usado na prévia ('__none__' = sem vendedor). Serve de
   * trava: card que mudou de dono depois da prévia é pulado, não roubado.
   */
  @IsOptional()
  @IsString()
  fromUserId?: string;
}
