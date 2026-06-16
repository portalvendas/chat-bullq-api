import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class AddDepartmentAgentDto {
  @ApiProperty({ description: 'User id of the agent to add to the department' })
  @IsUUID()
  userId: string;
}
