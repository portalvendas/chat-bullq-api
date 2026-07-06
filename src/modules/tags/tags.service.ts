import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { AutomationTrigger, Prisma } from '@prisma/client';
import { TagsRepository } from './tags.repository';
import { CreateTagDto } from './dto/create-tag.dto';
import { UpdateTagDto } from './dto/update-tag.dto';
import { PrismaService } from '../../database/prisma.service';
import { OutboxService } from '../automations/outbox/outbox.service';

const DEFAULT_TAG_COLOR = '#6B7280';

@Injectable()
export class TagsService {
  constructor(
    private readonly repository: TagsRepository,
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  async create(orgId: string, dto: CreateTagDto) {
    const existing = await this.repository.findByOrg(orgId);
    const dup = existing.find((t) => t.name.toLowerCase() === dto.name.toLowerCase());
    if (dup) {
      throw new ConflictException('A tag with this name already exists');
    }
    return this.repository.create({
      name: dto.name,
      color: dto.color ?? DEFAULT_TAG_COLOR,
      organization: { connect: { id: orgId } },
    });
  }

  async findAll(orgId: string) {
    return this.repository.findByOrg(orgId);
  }

  async findOne(id: string, orgId: string) {
    const tag = await this.repository.findById(id);
    if (!tag || tag.organizationId !== orgId) {
      throw new NotFoundException('Tag not found');
    }
    return tag;
  }

  async update(id: string, orgId: string, dto: UpdateTagDto) {
    await this.findOne(id, orgId);
    if (dto.name !== undefined) {
      const all = await this.repository.findByOrg(orgId);
      const dup = all.find(
        (t) => t.id !== id && t.name.toLowerCase() === dto.name!.toLowerCase(),
      );
      if (dup) {
        throw new ConflictException('A tag with this name already exists');
      }
    }
    return this.repository.update(id, {
      ...(dto.name !== undefined && { name: dto.name }),
      ...(dto.color !== undefined && { color: dto.color }),
    });
  }

  async remove(id: string, orgId: string) {
    await this.findOne(id, orgId);
    return this.repository.delete(id);
  }

  async addToConversation(
    convId: string,
    tagId: string,
    orgId: string,
    actorId?: string,
  ) {
    // Pre-flight checks outside the TX so we don't open one for nothing.
    await this.findOne(tagId, orgId);
    const conv = await this.repository.findConversationInOrg(convId, orgId);
    if (!conv) {
      throw new NotFoundException('Conversation not found');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const link = await tx.conversationTag.create({
          data: { conversationId: convId, tagId },
        });
        await this.outbox.enqueue(tx, AutomationTrigger.TAG_ADDED, {
          organizationId: orgId,
          contactId: conv.contactId,
          conversationId: conv.id,
          channelId: conv.channelId,
          actorId,
          tagId,
          target: 'conversation',
        });
        return link;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('Tag already applied to this conversation');
      }
      throw err;
    }
  }

  async removeFromConversation(
    convId: string,
    tagId: string,
    orgId: string,
    actorId?: string,
  ) {
    await this.findOne(tagId, orgId);
    const conv = await this.repository.findConversationInOrg(convId, orgId);
    if (!conv) {
      throw new NotFoundException('Conversation not found');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const removed = await tx.conversationTag.delete({
          where: { conversationId_tagId: { conversationId: convId, tagId } },
        });
        await this.outbox.enqueue(tx, AutomationTrigger.TAG_REMOVED, {
          organizationId: orgId,
          contactId: conv.contactId,
          conversationId: conv.id,
          channelId: conv.channelId,
          actorId,
          tagId,
          target: 'conversation',
        });
        return removed;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('Tag is not on this conversation');
      }
      throw err;
    }
  }

  async addToContact(
    contactId: string,
    tagId: string,
    orgId: string,
    actorId?: string,
  ) {
    await this.findOne(tagId, orgId);
    const contact = await this.repository.findContactInOrg(contactId, orgId);
    if (!contact) {
      throw new NotFoundException('Contact not found');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const link = await tx.contactTag.create({
          data: { contactId, tagId },
        });
        await this.outbox.enqueue(tx, AutomationTrigger.TAG_ADDED, {
          organizationId: orgId,
          contactId,
          actorId,
          tagId,
          target: 'contact',
        });
        return link;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        throw new ConflictException('Tag already applied to this contact');
      }
      throw err;
    }
  }

  async removeFromContact(
    contactId: string,
    tagId: string,
    orgId: string,
    actorId?: string,
  ) {
    await this.findOne(tagId, orgId);
    const contact = await this.repository.findContactInOrg(contactId, orgId);
    if (!contact) {
      throw new NotFoundException('Contact not found');
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        const removed = await tx.contactTag.delete({
          where: { contactId_tagId: { contactId, tagId } },
        });
        await this.outbox.enqueue(tx, AutomationTrigger.TAG_REMOVED, {
          organizationId: orgId,
          contactId,
          actorId,
          tagId,
          target: 'contact',
        });
        return removed;
      });
    } catch (err) {
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        throw new NotFoundException('Tag is not on this contact');
      }
      throw err;
    }
  }
}
