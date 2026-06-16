import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-custom';
import { Request } from 'express';
import { ApiKeysService } from '../api-keys/api-keys.service';
import { ChannelAccessService } from '../iam/channel-access/channel-access.service';

@Injectable()
export class ApiKeyStrategy extends PassportStrategy(Strategy, 'api-key') {
  constructor(
    private readonly apiKeysService: ApiKeysService,
    private readonly channelAccess: ChannelAccessService,
  ) {
    super();
  }

  async validate(req: Request): Promise<any> {
    const header = req.headers.authorization || (req.headers as any).Authorization;
    if (!header || typeof header !== 'string') {
      throw new UnauthorizedException('Missing API key');
    }

    const rawKey = (header.startsWith('Bearer ') ? header.slice(7) : header).trim();
    if (!rawKey.startsWith('pk_')) {
      throw new UnauthorizedException('Invalid API key format');
    }

    const result = await this.apiKeysService.validateKey(rawKey);
    if (!result) {
      throw new UnauthorizedException('Invalid or revoked API key');
    }

    (req as any).organization = result.organization;
    (req as any).accessibleChannelIds = await this.channelAccess.getAccessibleChannelIds(
      result.membership.id,
      result.membership.role,
      result.organization?.id,
    );
    return result.user;
  }
}
