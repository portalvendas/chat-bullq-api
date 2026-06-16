import { Injectable, NotFoundException } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../database/prisma.service';

@Injectable()
export class ApiKeysService {
  constructor(private readonly prisma: PrismaService) {}

  generateKey(): string {
    return 'pk_' + crypto.randomBytes(32).toString('base64url');
  }

  hashKey(rawKey: string): string {
    return crypto.createHash('sha256').update(rawKey).digest('hex');
  }

  async create(name: string, userId: string, organizationId: string, expiresAt?: string) {
    const rawKey = this.generateKey();
    const hashedKey = this.hashKey(rawKey);
    const prefix = rawKey.substring(0, 12);

    const apiKey = await this.prisma.apiKey.create({
      data: {
        name,
        prefix,
        hashedKey,
        userId,
        organizationId,
        expiresAt: expiresAt ? new Date(expiresAt) : null,
      },
    });

    return {
      id: apiKey.id,
      name: apiKey.name,
      prefix: apiKey.prefix,
      expiresAt: apiKey.expiresAt,
      createdAt: apiKey.createdAt,
      rawKey,
    };
  }

  async findAll(organizationId: string) {
    return this.prisma.apiKey.findMany({
      where: { organizationId, revokedAt: null },
      select: {
        id: true,
        name: true,
        prefix: true,
        lastUsedAt: true,
        expiresAt: true,
        createdAt: true,
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async revoke(id: string, organizationId: string) {
    const apiKey = await this.prisma.apiKey.findFirst({
      where: { id, organizationId, revokedAt: null },
    });

    if (!apiKey) {
      throw new NotFoundException('API key not found');
    }

    await this.prisma.apiKey.update({
      where: { id },
      data: { revokedAt: new Date() },
    });

    return { message: 'API key revoked' };
  }

  async validateKey(rawKey: string) {
    if (!rawKey?.startsWith('pk_')) return null;
    const hashedKey = this.hashKey(rawKey);

    const apiKey = await this.prisma.apiKey.findUnique({
      where: { hashedKey },
      include: {
        user: { select: { id: true, name: true, email: true, isActive: true } },
        organization: { select: { id: true, name: true, slug: true } },
      },
    });

    if (!apiKey) return null;
    if (apiKey.revokedAt) return null;
    if (apiKey.expiresAt && apiKey.expiresAt < new Date()) return null;
    if (!apiKey.user.isActive) return null;

    const membership = await this.prisma.userOrganization.findUnique({
      where: {
        userId_organizationId: {
          userId: apiKey.user.id,
          organizationId: apiKey.organizationId,
        },
      },
    });
    if (!membership) return null;

    this.prisma.apiKey
      .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {});

    return {
      user: {
        id: apiKey.user.id,
        name: apiKey.user.name,
        email: apiKey.user.email,
      },
      organization: {
        id: apiKey.organization.id,
        name: apiKey.organization.name,
        slug: apiKey.organization.slug,
        userRole: membership.role,
        userOrganizationId: membership.id,
      },
      membership,
      apiKeyId: apiKey.id,
    };
  }
}
