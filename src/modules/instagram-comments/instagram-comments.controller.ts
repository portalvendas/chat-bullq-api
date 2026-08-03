import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InstagramCommentsService } from './instagram-comments.service';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg } from '../../common/decorators';

@ApiTags('Instagram Comments')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('instagram/comments')
export class InstagramCommentsController {
  constructor(private readonly service: InstagramCommentsService) {}

  @Get()
  @ApiOperation({ summary: 'Lista comentários do Instagram (paginado, fora do inbox)' })
  list(
    @CurrentOrg('id') orgId: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
    @Query('status') status?: string,
  ) {
    return this.service.list(orgId, {
      cursor,
      limit: limit ? Number(limit) : undefined,
      status,
    });
  }

  @Post(':id/reply-public')
  @ApiOperation({ summary: 'Responde o comentário publicamente (no post)' })
  replyPublic(
    @CurrentOrg('id') orgId: string,
    @Param('id') id: string,
    @Body() body: { text: string },
  ) {
    return this.service.replyPublic(orgId, id, body?.text ?? '');
  }

  @Post(':id/reply-dm')
  @ApiOperation({ summary: 'Envia DM privada (private reply) ao autor do comentário' })
  replyDm(
    @CurrentOrg('id') orgId: string,
    @Param('id') id: string,
    @Body() body: { text?: string },
  ) {
    return this.service.replyDm(orgId, id, body?.text);
  }

  @Post(':id/convert-lead')
  @ApiOperation({ summary: 'Converte o comentário em lead (card na etapa de entrada)' })
  convertLead(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.convertLead(orgId, id);
  }
}
