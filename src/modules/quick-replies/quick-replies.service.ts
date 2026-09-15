import {
  Injectable,
  NotFoundException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { QuickRepliesRepository } from './quick-replies.repository';
import { CreateQuickReplyDto } from './dto/create-quick-reply.dto';
import { UpdateQuickReplyDto } from './dto/update-quick-reply.dto';

@Injectable()
export class QuickRepliesService {
  constructor(private readonly repository: QuickRepliesRepository) {}

  async create(orgId: string, userId: string, dto: CreateQuickReplyDto) {
    const ownerId = dto.scope === 'PERSONAL' ? userId : null;
    const clash = await this.repository.findByShortcutScoped(
      orgId,
      ownerId,
      dto.shortcut,
    );
    if (clash) {
      throw new ConflictException(
        ownerId
          ? 'Você já tem uma resposta com esse atalho'
          : 'Já existe uma resposta da empresa com esse atalho',
      );
    }
    return this.repository.create({
      shortcut: dto.shortcut,
      title: dto.title,
      content: dto.content,
      attachments: (dto.attachments ?? []) as any,
      organization: { connect: { id: orgId } },
      ...(ownerId ? { user: { connect: { id: ownerId } } } : {}),
    });
  }

  /** Lista visíveis: compartilhadas da org + pessoais do usuário. */
  async findAll(orgId: string, userId: string) {
    return this.repository.findVisible(orgId, userId);
  }

  /** Carrega verificando org + visibilidade (não vê pessoal de outro). */
  async findOne(id: string, orgId: string, userId: string) {
    const row = await this.repository.findById(id);
    if (!row || row.organizationId !== orgId) {
      throw new NotFoundException('Resposta rápida não encontrada');
    }
    if (row.userId && row.userId !== userId) {
      throw new NotFoundException('Resposta rápida não encontrada');
    }
    return row;
  }

  async update(
    id: string,
    orgId: string,
    userId: string,
    dto: UpdateQuickReplyDto,
  ) {
    const row = await this.findOne(id, orgId, userId);
    // Pessoal só o dono edita; da empresa qualquer membro pode.
    if (row.userId && row.userId !== userId) {
      throw new ForbiddenException('Sem permissão para editar esta resposta');
    }

    // Escopo alvo (se mudou): PERSONAL -> este usuário; ORG -> null.
    const targetOwnerId =
      dto.scope === 'PERSONAL'
        ? userId
        : dto.scope === 'ORG'
          ? null
          : row.userId;
    const targetShortcut = dto.shortcut ?? row.shortcut;

    // Conflito de atalho no escopo alvo (ignorando a própria linha).
    if (dto.shortcut !== undefined || dto.scope !== undefined) {
      const clash = await this.repository.findByShortcutScoped(
        orgId,
        targetOwnerId ?? null,
        targetShortcut,
      );
      if (clash && clash.id !== id) {
        throw new ConflictException('Atalho já em uso nesse escopo');
      }
    }

    return this.repository.update(id, {
      ...(dto.shortcut !== undefined && { shortcut: dto.shortcut }),
      ...(dto.title !== undefined && { title: dto.title }),
      ...(dto.content !== undefined && { content: dto.content }),
      ...(dto.attachments !== undefined && {
        attachments: dto.attachments as any,
      }),
      ...(dto.scope !== undefined && {
        user:
          targetOwnerId === null
            ? { disconnect: true }
            : { connect: { id: targetOwnerId } },
      }),
    });
  }

  async remove(id: string, orgId: string, userId: string) {
    const row = await this.findOne(id, orgId, userId);
    if (row.userId && row.userId !== userId) {
      throw new ForbiddenException('Sem permissão para remover esta resposta');
    }
    return this.repository.softDelete(id);
  }
}
