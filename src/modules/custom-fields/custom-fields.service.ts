import { BadRequestException, Injectable } from '@nestjs/common';
import { CustomFieldEntity, CustomFieldType } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';

export interface CustomFieldInput {
  label: string;
  entity?: CustomFieldEntity;
  type?: CustomFieldType;
  key?: string;
}

/** Normaliza um label pra uma key estável (a-z0-9_) usada em metadata.custom. */
export function slugifyKey(s: string): string {
  return (
    (s ?? '')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 60) || 'campo'
  );
}

@Injectable()
export class CustomFieldsService {
  constructor(private readonly prisma: PrismaService) {}

  list(organizationId: string, entity?: CustomFieldEntity) {
    return this.prisma.customField.findMany({
      where: { organizationId, ...(entity ? { entity } : {}) },
      orderBy: [{ entity: 'asc' }, { order: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** Cria (ou retorna o existente) um campo personalizado. Idempotente por key. */
  async create(organizationId: string, dto: CustomFieldInput) {
    if (!dto?.label?.trim()) throw new BadRequestException('label é obrigatório');
    const entity = (dto.entity ?? 'CARD') as CustomFieldEntity;
    const key = slugifyKey(dto.key || dto.label);

    const existing = await this.prisma.customField.findUnique({
      where: { organizationId_entity_key: { organizationId, entity, key } },
    });
    if (existing) return existing;

    const max = await this.prisma.customField.findFirst({
      where: { organizationId, entity },
      orderBy: { order: 'desc' },
      select: { order: true },
    });
    return this.prisma.customField.create({
      data: {
        organizationId,
        entity,
        key,
        label: dto.label.trim(),
        type: (dto.type ?? 'TEXT') as CustomFieldType,
        order: (max?.order ?? -1) + 1,
      },
    });
  }

  /** Garante que uma lista de campos existe (usado pelo import). */
  async ensureMany(organizationId: string, fields: CustomFieldInput[]) {
    const out = [];
    for (const f of fields ?? []) {
      if (f?.label?.trim()) out.push(await this.create(organizationId, f));
    }
    return out;
  }

  async remove(organizationId: string, id: string) {
    const f = await this.prisma.customField.findUnique({ where: { id } });
    if (!f || f.organizationId !== organizationId) {
      throw new BadRequestException('Campo não encontrado');
    }
    await this.prisma.customField.delete({ where: { id } });
    return { ok: true };
  }
}
