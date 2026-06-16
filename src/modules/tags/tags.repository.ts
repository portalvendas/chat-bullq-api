import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class TagsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.TagCreateInput) {
    return this.prisma.tag.create({ data });
  }

  async findByOrg(organizationId: string) {
    return this.prisma.tag.findMany({
      where: { organizationId },
      orderBy: { name: 'asc' },
    });
  }

  async findById(id: string) {
    return this.prisma.tag.findUnique({ where: { id } });
  }

  async update(id: string, data: Prisma.TagUpdateInput) {
    return this.prisma.tag.update({ where: { id }, data });
  }

  async delete(id: string) {
    return this.prisma.tag.delete({ where: { id } });
  }

  async addTagToConversation(conversationId: string, tagId: string) {
    return this.prisma.conversationTag.create({
      data: { conversationId, tagId },
    });
  }

  async removeTagFromConversation(conversationId: string, tagId: string) {
    return this.prisma.conversationTag.delete({
      where: {
        conversationId_tagId: { conversationId, tagId },
      },
    });
  }

  async addTagToContact(contactId: string, tagId: string) {
    return this.prisma.contactTag.create({
      data: { contactId, tagId },
    });
  }

  async removeTagFromContact(contactId: string, tagId: string) {
    return this.prisma.contactTag.delete({
      where: {
        contactId_tagId: { contactId, tagId },
      },
    });
  }

  async findConversationInOrg(conversationId: string, organizationId: string) {
    return this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId },
    });
  }

  async findContactInOrg(contactId: string, organizationId: string) {
    return this.prisma.contact.findFirst({
      where: { id: contactId, organizationId },
    });
  }
}
