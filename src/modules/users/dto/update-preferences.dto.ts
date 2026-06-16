import { IsObject } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class UpdatePreferencesDto {
  @ApiProperty({
    description:
      'Shallow-merged into the current preferences JSON. Pass null in a key to remove it.',
    example: { inbox: { scope: 'MINE', statusFilters: ['PENDING'] } },
  })
  @IsObject()
  preferences!: Record<string, unknown>;
}
