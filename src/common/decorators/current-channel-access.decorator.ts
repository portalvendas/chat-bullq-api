import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { ChannelAccess } from '../../modules/iam/channel-access/channel-access.service';

export const CurrentChannelAccess = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): ChannelAccess => {
    const request = ctx.switchToHttp().getRequest();
    return request.accessibleChannelIds ?? new Set<string>();
  },
);
