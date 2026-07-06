import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import {
  CreateProductDto,
  UpdateProductDto,
} from './dto/product.dto';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string, includeInactive = false) {
    return this.prisma.product.findMany({
      where: {
        organizationId,
        ...(includeInactive ? {} : { isActive: true }),
      },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async findOne(id: string, organizationId: string) {
    const product = await this.prisma.product.findUnique({ where: { id } });
    if (!product || product.organizationId !== organizationId) {
      throw new NotFoundException('Product not found');
    }
    return product;
  }

  async findBySlug(organizationId: string, slug: string) {
    const product = await this.prisma.product.findUnique({
      where: {
        organizationId_slug: { organizationId, slug },
      },
    });
    if (!product) throw new NotFoundException('Product not found');
    return product;
  }

  async create(organizationId: string, dto: CreateProductDto) {
    const exists = await this.prisma.product.findUnique({
      where: {
        organizationId_slug: { organizationId, slug: dto.slug },
      },
    });
    if (exists) {
      throw new BadRequestException(
        `Já existe produto com slug "${dto.slug}" nessa org`,
      );
    }

    const max = await this.prisma.product.findFirst({
      where: { organizationId },
      orderBy: { order: 'desc' },
      select: { order: true },
    });

    return this.prisma.product.create({
      data: {
        organizationId,
        slug: dto.slug,
        name: dto.name,
        category: dto.category,
        shortLine: dto.shortLine,
        pitch: dto.pitch,
        price: dto.price,
        paymentLink: dto.paymentLink,
        targetAudience: dto.targetAudience,
        differentiators: dto.differentiators ?? [],
        isActive: dto.isActive ?? true,
        order: dto.order ?? (max?.order ?? -1) + 1,
      },
    });
  }

  async update(id: string, organizationId: string, dto: UpdateProductDto) {
    const existing = await this.findOne(id, organizationId);
    if (dto.slug && dto.slug !== existing.slug) {
      const conflict = await this.prisma.product.findUnique({
        where: {
          organizationId_slug: { organizationId, slug: dto.slug },
        },
      });
      if (conflict) {
        throw new BadRequestException(
          `Slug "${dto.slug}" já usado por outro produto`,
        );
      }
    }
    return this.prisma.product.update({
      where: { id },
      data: {
        ...(dto.slug !== undefined ? { slug: dto.slug } : {}),
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.category !== undefined ? { category: dto.category } : {}),
        ...(dto.shortLine !== undefined ? { shortLine: dto.shortLine } : {}),
        ...(dto.pitch !== undefined ? { pitch: dto.pitch } : {}),
        ...(dto.price !== undefined ? { price: dto.price } : {}),
        ...(dto.paymentLink !== undefined
          ? { paymentLink: dto.paymentLink }
          : {}),
        ...(dto.targetAudience !== undefined
          ? { targetAudience: dto.targetAudience }
          : {}),
        ...(dto.differentiators !== undefined
          ? { differentiators: dto.differentiators }
          : {}),
        ...(dto.isActive !== undefined ? { isActive: dto.isActive } : {}),
        ...(dto.order !== undefined ? { order: dto.order } : {}),
      },
    });
  }

  async remove(id: string, organizationId: string) {
    await this.findOne(id, organizationId);
    await this.prisma.product.delete({ where: { id } });
  }

  async reorder(organizationId: string, ids: string[]) {
    const owned = await this.prisma.product.findMany({
      where: { organizationId, id: { in: ids } },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      throw new BadRequestException('Some ids do not belong to this org');
    }
    await this.prisma.$transaction(
      ids.map((id, idx) =>
        this.prisma.product.update({
          where: { id },
          data: { order: idx },
        }),
      ),
    );
  }

  /**
   * Compact list used by the AI prompt builder. Returns only active
   * products, grouped by category, with name + slug + shortLine.
   * Skill `getProductPitch(slug)` fetches the full pitch on demand.
   */
  async listForAiPrompt(organizationId: string) {
    return this.prisma.product.findMany({
      where: { organizationId, isActive: true },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      select: {
        slug: true,
        name: true,
        category: true,
        shortLine: true,
      },
    });
  }
}
