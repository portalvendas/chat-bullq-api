import { IsArray, IsString, ArrayUnique } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class SetMemberChannelsDto {
  @ApiProperty({
    type: [String],
    description: 'Replaces the full set of channels the member can access.',
  })
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  channelIds: string[];
}
