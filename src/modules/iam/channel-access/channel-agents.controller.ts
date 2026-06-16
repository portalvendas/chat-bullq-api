import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { CurrentOrg, CurrentUser, Roles } from '../../../common/decorators';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../../common/guards';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { ChannelAccessService } from './channel-access.service';
import { AddChannelAgentDto } from './dto/add-channel-agent.dto';

@ApiTags('Channel Access')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('channels')
export class ChannelAgentsController {
  constructor(
    private readonly service: ChannelAccessService,
    private readonly realtime: RealtimeGateway,
  ) {}

  @Get(':channelId/agents')
  @ApiOperation({ summary: 'List AGENTs explicitly granted access to this channel.' })
  list(
    @CurrentOrg('id') orgId: string,
    @Param('channelId') channelId: string,
  ) {
    return this.service.listChannelAgents(orgId, channelId);
  }

  @Post(':channelId/agents')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Grant a member access to this channel.' })
  async add(
    @CurrentOrg('id') orgId: string,
    @CurrentUser('id') actorId: string,
    @Param('channelId') channelId: string,
    @Body() dto: AddChannelAgentDto,
  ) {
    const result = await this.service.addChannelAgent(
      orgId,
      channelId,
      dto.userId,
      actorId,
    );
    await this.realtime.grantChannelToUser(result.userId, channelId);
    return { granted: true };
  }

  @Delete(':channelId/agents/:userId')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Revoke a member from this channel.' })
  async remove(
    @CurrentOrg('id') orgId: string,
    @Param('channelId') channelId: string,
    @Param('userId') userId: string,
  ) {
    const result = await this.service.removeChannelAgent(orgId, channelId, userId);
    await this.realtime.revokeChannelFromUser(result.userId, channelId);
    return { revoked: true };
  }

  @Get(':channelId/eligible-agents')
  @ApiOperation({
    summary:
      'Members eligible to be assigned a conversation in this channel — used by the assignee picker.',
  })
  eligible(
    @CurrentOrg('id') orgId: string,
    @Param('channelId') channelId: string,
  ) {
    return this.service.listEligibleAgents(orgId, channelId);
  }
}
