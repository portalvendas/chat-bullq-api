import {
  Injectable,
  NotFoundException,
  ConflictException,
} from '@nestjs/common';
import { QuickRepliesRepository } from './quick-replies.repository';
import { CreateQuickReplyDto } from './dto/create-quick-reply.dto';
import { UpdateQuickReplyDto } from './dto/update-quick-reply.dto';

@Injectable()
export class QuickRepliesService {
  constructor(private readonly repository: QuickRepliesRepository) {}

  async create(orgId: string, dto: CreateQuickReplyDto) {
    const existing = await this.repository.findByShortcut(orgId, dto.shortcut);
    if (existing) {
      throw new ConflictException('Shortcut already in use');
    }
    return this.repository.create({
      shortcut: dto.shortcut,
      title: dto.title,
      content: dto.content,
      organization: { connect: { id: orgId } },
    });
  }

  async findAll(orgId: string) {
    return this.repository.findByOrg(orgId);
  }

  async findOne(id: string, orgId: string) {
    const row = await this.repository.findById(id);
    if (!row || row.organizationId !== orgId) {
      throw new NotFoundException('Quick reply not found');
    }
    return row;
  }

  async update(id: string, orgId: string, dto: UpdateQuickReplyDto) {
    await this.findOne(id, orgId);
    if (dto.shortcut !== undefined) {
      const clash = await this.repository.findByShortcut(orgId, dto.shortcut);
      if (clash && clash.id !== id) {
        throw new ConflictException('Shortcut already in use');
      }
    }
    return this.repository.update(id, {
      ...(dto.shortcut !== undefined && { shortcut: dto.shortcut }),
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.content !== undefined && { content: dto.content }),
    });
  }

  async remove(id: string, orgId: string) {
    await this.findOne(id, orgId);
    return this.repository.softDelete(id);
  }
}
