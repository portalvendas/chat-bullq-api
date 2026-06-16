import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { UpsertToolDto } from './dto/upsert-tool.dto';

@Injectable()
export class ToolsCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string) {
    return this.prisma.aiTool.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: [{ source: 'asc' }, { name: 'asc' }],
      include: { _count: { select: { skills: true } } },
    });
  }

  async findOne(organizationId: string, id: string) {
    const tool = await this.prisma.aiTool.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: { skills: { select: { id: true, name: true } } },
    });
    if (!tool) throw new NotFoundException('Tool not found');
    return tool;
  }

  async create(organizationId: string, dto: UpsertToolDto) {
    this.assertSourceFields(dto);
    await this.assertNameAvailable(organizationId, dto.name);

    return this.prisma.aiTool.create({
      data: {
        organizationId,
        name: dto.name,
        description: dto.description,
        source: dto.source,
        httpBaseUrl: dto.httpBaseUrl,
        httpHeaders: (dto.httpHeaders as object) ?? {},
        sqlConnectionRef: dto.sqlConnectionRef,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async update(organizationId: string, id: string, dto: UpsertToolDto) {
    const tool = await this.findOne(organizationId, id);
    this.assertSourceFields(dto);
    if (tool.name !== dto.name) {
      await this.assertNameAvailable(organizationId, dto.name);
    }
    return this.prisma.aiTool.update({
      where: { id },
      data: {
        name: dto.name,
        description: dto.description,
        source: dto.source,
        httpBaseUrl: dto.httpBaseUrl,
        httpHeaders: (dto.httpHeaders as object) ?? {},
        sqlConnectionRef: dto.sqlConnectionRef,
        isActive: dto.isActive ?? true,
      },
    });
  }

  async softDelete(organizationId: string, id: string) {
    await this.findOne(organizationId, id);
    await this.prisma.aiTool.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  private assertSourceFields(dto: UpsertToolDto) {
    if (dto.source === 'CUSTOM_HTTP' && !dto.httpBaseUrl) {
      throw new BadRequestException('CUSTOM_HTTP requires httpBaseUrl');
    }
    if (dto.source === 'CUSTOM_SQL' && !dto.sqlConnectionRef) {
      throw new BadRequestException('CUSTOM_SQL requires sqlConnectionRef');
    }
  }

  private async assertNameAvailable(organizationId: string, name: string) {
    const clash = await this.prisma.aiTool.findFirst({
      where: { organizationId, name, deletedAt: null },
    });
    if (clash) {
      throw new BadRequestException(`Tool "${name}" já existe na organização.`);
    }
  }
}
