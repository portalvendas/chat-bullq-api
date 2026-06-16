import { Global, Module } from '@nestjs/common';
import { ChannelAccessService } from './channel-access.service';
import { MemberChannelsController } from './member-channels.controller';
import { ChannelAgentsController } from './channel-agents.controller';

@Global()
@Module({
  controllers: [MemberChannelsController, ChannelAgentsController],
  providers: [ChannelAccessService],
  exports: [ChannelAccessService],
})
export class ChannelAccessModule {}
