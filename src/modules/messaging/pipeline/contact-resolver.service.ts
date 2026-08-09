import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { NormalizedInboundMessage } from '../../channel-hub/ports/types';
import { IdempotencyService } from './idempotency.service';
import { phoneVariants } from '../../../common/phone.util';

export interface ResolvedContact {
  contactId: string;
  contactChannelId: string;
  isNew: boolean;
}

@Injectable()
export class ContactResolverService {
  private readonly logger = new Logger(ContactResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
  ) {}

  async resolve(
    organizationId: string,
    channelId: string,
    message: NormalizedInboundMessage,
  ): Promise<ResolvedContact> {
    // Fast path: already exists, just refresh mutable fields.
    const existing = await this.prisma.contactChannel.findUnique({
      where: {
        uq_contact_channel_external: {
          channelId,
          externalId: message.externalContactId,
        },
      },
      include: { contact: true },
    });

    if (existing) {
      await this.applyProfileUpdates(existing, message);
      return {
        contactId: existing.contactId,
        contactChannelId: existing.id,
        isNew: false,
      };
    }

    // Slow path: needs insert. Serialise per (channel, externalId) to avoid
    // race between concurrent webhooks for the same brand-new contact.
    return this.idempotency.withLock(
      `contact:${channelId}:${message.externalContactId}`,
      async () => {
        // Re-check inside the lock — another worker may have just created it.
        const racer = await this.prisma.contactChannel.findUnique({
          where: {
            uq_contact_channel_external: {
              channelId,
              externalId: message.externalContactId,
            },
          },
          include: { contact: true },
        });
        if (racer) {
          await this.applyProfileUpdates(racer, message);
          return {
            contactId: racer.contactId,
            contactChannelId: racer.id,
            isNew: false,
          };
        }

        // Unificação por TELEFONE: se já existe um contato com esse número
        // (ex.: veio antes pela Landing Page / Facebook / Instagram, ou é o
        // WhatsApp chegando depois do card do formulário), anexa ESTE canal a
        // ele em vez de criar um contato novo — assim WhatsApp + card do lead
        // ficam no MESMO contato. Só cruza quando temos telefone real.
        if (message.contactPhone) {
          // Match por VARIANTES (cobre o 9º dígito BR e DDI): o número do
          // WhatsApp às vezes vem sem o 9, e o card do formulário tem o 9.
          const byPhone = await this.prisma.contact.findFirst({
            where: {
              organizationId,
              phone: { in: phoneVariants(message.contactPhone) },
            },
            orderBy: { createdAt: 'asc' },
            select: { id: true, name: true, phone: true },
          });
          if (byPhone) {
            const cc = await this.prisma.contactChannel.create({
              data: {
                contactId: byPhone.id,
                channelId,
                externalId: message.externalContactId,
                profileName: message.contactName,
                profileAvatarUrl: message.contactAvatarUrl,
              },
            });
            await this.applyProfileUpdates(
              {
                id: cc.id,
                profileName: cc.profileName,
                profileAvatarUrl: cc.profileAvatarUrl,
                contactId: byPhone.id,
                contact: { name: byPhone.name, phone: byPhone.phone },
              },
              message,
            );
            this.logger.log(
              `Contato unificado por telefone: canal ${channelId} anexado ao contato ${byPhone.id} (${message.contactPhone})`,
            );
            return {
              contactId: byPhone.id,
              contactChannelId: cc.id,
              isNew: false,
            };
          }
        }

        const contact = await this.prisma.contact.create({
          data: {
            organizationId,
            name: message.contactName,
            phone: message.contactPhone,
            avatarUrl: message.contactAvatarUrl,
            channels: {
              create: {
                channelId,
                externalId: message.externalContactId,
                profileName: message.contactName,
                profileAvatarUrl: message.contactAvatarUrl,
              },
            },
          },
          include: { channels: true },
        });

        this.logger.log(
          `New contact created: ${contact.id} (${message.contactPhone || message.externalContactId})`,
        );

        return {
          contactId: contact.id,
          contactChannelId: contact.channels[0].id,
          isNew: true,
        };
      },
    );
  }

  private async applyProfileUpdates(
    existing: {
      id: string;
      profileName: string | null;
      profileAvatarUrl: string | null;
      contactId: string;
      contact: { name: string | null; phone: string | null };
    },
    message: NormalizedInboundMessage,
  ): Promise<void> {
    const ccUpdates: Record<string, any> = {};
    if (message.contactName && message.contactName !== existing.profileName) {
      ccUpdates.profileName = message.contactName;
    }
    if (
      message.contactAvatarUrl &&
      message.contactAvatarUrl !== existing.profileAvatarUrl
    ) {
      ccUpdates.profileAvatarUrl = message.contactAvatarUrl;
    }
    if (Object.keys(ccUpdates).length > 0) {
      await this.prisma.contactChannel.update({
        where: { id: existing.id },
        data: ccUpdates,
      });
    }

    const contactUpdates: Record<string, any> = {};
    if (message.contactName && !existing.contact.name) {
      contactUpdates.name = message.contactName;
    }
    if (message.contactPhone && !existing.contact.phone) {
      contactUpdates.phone = message.contactPhone;
    }
    if (Object.keys(contactUpdates).length > 0) {
      await this.prisma.contact.update({
        where: { id: existing.contactId },
        data: contactUpdates,
      });
    }
  }
}
