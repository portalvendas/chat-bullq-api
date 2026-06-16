import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { ZappfyHttpClient } from './zappfy.http-client';

/**
 * Pulls profile picture (and best-effort name) for a WhatsApp contact via
 * the Zappfy/uazapi `/chat/find` endpoint. Called lazily on inbound: if
 * the contact already has avatarUrl, we skip — saves a roundtrip per
 * incoming message.
 */
@Injectable()
export class ZappfyContactEnricherService {
  private readonly logger = new Logger(ZappfyContactEnricherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpClient: ZappfyHttpClient,
  ) {}

  async enrich(channel: Channel, externalContactId: string): Promise<void> {
    try {
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

      // Skip if already enriched. Foto + nome do contato podem mudar no
      // WhatsApp, mas pra MVP vamos só preencher uma vez.
      if (contactChannel.contact.avatarUrl) return;

      const chat = await this.fetchChat(channel, externalContactId);
      if (!chat) return;

      const avatarUrl: string | undefined = chat.wa_profilePicUrl || undefined;
      const profileName: string | undefined =
        chat.wa_contactName || chat.wa_name || undefined;

      if (!avatarUrl && !profileName) return;

      const ccUpdates: Record<string, any> = {};
      if (profileName && profileName !== contactChannel.profileName) {
        ccUpdates.profileName = profileName;
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
      if (profileName && !contactChannel.contact.name) {
        contactUpdates.name = profileName;
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
        `Zappfy contact enriched: ${externalContactId} → ${profileName ?? '(no name)'} ${avatarUrl ? '+ avatar' : ''}`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Zappfy contact enrichment failed for ${externalContactId}: ${err.message}`,
      );
    }
  }

  private async fetchChat(
    channel: Channel,
    chatId: string,
  ): Promise<any | null> {
    // /chat/find aceita filtros — passamos wa_chatid pra buscar o chat
    // exato e ler wa_profilePicUrl + wa_contactName / wa_name.
    try {
      const response = await this.httpClient.sendRequest(
        channel,
        '/chat/find',
        { wa_chatid: chatId, limit: 1 },
      );
      const chats = response?.chats ?? response?.data ?? response;
      return Array.isArray(chats) ? chats[0] : chats?.[0] ?? null;
    } catch (err: any) {
      this.logger.warn(
        `Zappfy fetchChat failed for ${chatId}: ${err.message}`,
      );
      return null;
    }
  }
}
