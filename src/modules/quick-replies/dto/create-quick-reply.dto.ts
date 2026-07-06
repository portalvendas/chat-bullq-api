import { IsString } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateQuickReplyDto {
  @ApiProperty()
  @IsString()
  shortcut: string;

  @ApiProperty()
  @IsString()
  title: string;

  @ApiProperty()
  @IsString()
  content: string;
}
