import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Body,
  Param,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { QuickRepliesService } from './quick-replies.service';
import { CreateQuickReplyDto } from './dto/create-quick-reply.dto';
import { UpdateQuickReplyDto } from './dto/update-quick-reply.dto';
import { JwtAuthGuard, OrgGuard } from '../../common/guards';
import { CurrentOrg, CurrentUser } from '../../common/decorators';

@ApiTags('Quick replies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard)
@Controller('quick-replies')
export class QuickRepliesController {
  constructor(private readonly service: QuickRepliesService) {}

  @Post()
  @ApiOperation({ summary: 'Create quick reply (ORG ou PERSONAL)' })
  create(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CreateQuickReplyDto,
  ) {
    return this.service.create(orgId, userId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List quick replies visíveis (empresa + pessoais)' })
  findAll(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.findAll(orgId, userId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get quick reply by id' })
  findOne(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.findOne(id, orgId, userId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update quick reply' })
  update(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateQuickReplyDto,
  ) {
    return this.service.update(id, orgId, userId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Soft-delete quick reply' })
  remove(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.remove(id, orgId, userId);
  }
}
