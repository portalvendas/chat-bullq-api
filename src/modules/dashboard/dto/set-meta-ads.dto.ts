import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

export class SetMetaAdsDto {
  @ApiProperty({ description: 'ID da conta de anúncios (só o número; act_ é opcional)' })
  @IsString()
  @MinLength(1)
  adAccountId!: string;

  @ApiProperty({ description: 'Token de Usuário do Sistema com ads_read' })
  @IsString()
  @MinLength(10)
  accessToken!: string;
}
