import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNotEmpty } from 'class-validator';

export class PurgeOrganizationDto {
  @ApiProperty({
    description:
      'Slug EXATO da empresa — confirmação obrigatória da exclusão definitiva.',
  })
  @IsString()
  @IsNotEmpty()
  confirmSlug!: string;
}
