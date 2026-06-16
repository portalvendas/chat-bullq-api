import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AddChannelAgentDto {
  @ApiProperty({ description: 'User ID of the member to grant access to.' })
  @IsString()
  userId: string;
}
