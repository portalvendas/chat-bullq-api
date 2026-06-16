import { IsEnum } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';

export class UpdateMemberRoleDto {
  @ApiProperty({ enum: OrgRole, example: OrgRole.ADMIN })
  @IsEnum(OrgRole)
  role: OrgRole;
}
