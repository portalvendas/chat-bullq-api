import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  BadRequestException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../database/prisma.service';
import { ChannelAccessService } from '../../modules/iam/channel-access/channel-access.service';
import { IS_PUBLIC_KEY } from '../decorators';

@Injectable()
export class OrgGuard implements CanActivate {
  constructor(
    private prisma: PrismaService,
    private reflector: Reflector,
    private channelAccess: ChannelAccessService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest();
    const organizationId = request.headers['x-organization-id'];
    const userId = request.user?.id;

    if (!organizationId) {
      throw new BadRequestException('x-organization-id header is required');
    }

    if (!userId) {
      throw new ForbiddenException('User not authenticated');
    }

    const membership = await this.prisma.userOrganization.findUnique({
      where: {
        userId_organizationId: { userId, organizationId },
      },
      include: { organization: true },
    });

    if (!membership) {
      throw new ForbiddenException('You are not a member of this organization');
    }

    request.organization = {
      id: membership.organizationId,
      name: membership.organization.name,
      slug: membership.organization.slug,
      userRole: membership.role,
      userOrganizationId: membership.id,
    };

    request.accessibleChannelIds = await this.channelAccess.getAccessibleChannelIds(
      membership.id,
      membership.role,
      membership.organizationId,
    );

    return true;
  }
}
