import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { InstagramHttpClient } from './instagram.http-client';

@Injectable()
export class InstagramContactEnricherService {
  private readonly logger = new Logger(InstagramContactEnricherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpClient: InstagramHttpClient,
  ) {}

  async enrich(channel: Channel, externalContactId: string): Promise<void> {
    try {
      const info = await this.fetchUserInfo(channel, externalContactId);
      if (!info) return;

      const username = info.username || info.name;
      const avatarUrl = info.profile_pic;
      if (!username && !avatarUrl) return;

      const contactChannel = await this.prisma.contactChannel.findUnique({
        where: {
          uq_contact_channel_external: {
            channelId: channel.id,
            externalId: externalContactId,
          },
        },
        include: { contact: true },
      });
      if (!contactChannel) return;

      const ccUpdates: Record<string, any> = {};
      if (username && username !== contactChannel.profileName) {
        ccUpdates.profileName = username;
      }
      if (avatarUrl && avatarUrl !== contactChannel.profileAvatarUrl) {
        ccUpdates.profileAvatarUrl = avatarUrl;
      }
      if (Object.keys(ccUpdates).length > 0) {
        await this.prisma.contactChannel.update({
          where: { id: contactChannel.id },
          data: ccUpdates,
        });
      }

      const contactUpdates: Record<string, any> = {};
      if (username && !contactChannel.contact.name) {
        contactUpdates.name = username;
      }
      if (avatarUrl && !contactChannel.contact.avatarUrl) {
        contactUpdates.avatarUrl = avatarUrl;
      }
      if (Object.keys(contactUpdates).length > 0) {
        await this.prisma.contact.update({
          where: { id: contactChannel.contactId },
          data: contactUpdates,
        });
      }

      this.logger.log(
        `Instagram contact enriched: ${externalContactId} → ${username || '(no username)'}`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Instagram contact enrichment failed for ${externalContactId}: ${err.message}`,
      );
    }
  }

  private async fetchUserInfo(
    channel: Channel,
    igUserId: string,
  ): Promise<{ username?: string; name?: string; profile_pic?: string } | null> {
    try {
      const data = await this.httpClient.getUserProfile(channel, igUserId);
      return data;
    } catch {
      return null;
    }
  }
}
