import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiOperation, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { ApiKeyAuthGuard } from '../../../common/guards';
import { CurrentOrg, CurrentUser } from '../../../common/decorators';

@ApiTags('Public API · Me')
@ApiSecurity('api-key')
@UseGuards(ApiKeyAuthGuard)
@Controller('public/me')
export class PublicMeController {
  @Get()
  @ApiOperation({ summary: 'Identifies the API key holder (user + organization)' })
  whoami(@CurrentUser() user: any, @CurrentOrg() organization: any) {
    return { user, organization };
  }
}
