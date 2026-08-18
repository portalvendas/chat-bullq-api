import { ApiProperty } from '@nestjs/swagger';
import { IsString, MaxLength, MinLength } from 'class-validator';

export class UpdatePlanDto {
  @ApiProperty({ example: 'pro' })
  @IsString()
  @MinLength(1)
  @MaxLength(60)
  plan!: string;
}
