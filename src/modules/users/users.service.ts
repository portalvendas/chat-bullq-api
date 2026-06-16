import {
  Injectable,
  BadRequestException,
  NotFoundException,
  Logger,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { ChangePasswordDto } from './dto/change-password.dto';

const BCRYPT_ROUNDS = 12;

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(private readonly prisma: PrismaService) {}

  async updateProfile(userId: string, dto: UpdateProfileDto) {
    const user = await this.prisma.user.update({
      where: { id: userId },
      data: dto,
    });

    const { password: _, ...sanitized } = user;
    return sanitized;
  }

  async changePassword(userId: string, dto: ChangePasswordDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) {
      throw new BadRequestException('User not found');
    }

    const isValid = await bcrypt.compare(dto.currentPassword, user.password);
    if (!isValid) {
      throw new BadRequestException('Current password is incorrect');
    }

    const hashedPassword = await bcrypt.hash(dto.newPassword, BCRYPT_ROUNDS);
    await this.prisma.user.update({
      where: { id: userId },
      data: { password: hashedPassword },
    });

    this.logger.log(`Password changed for user ${userId}`);
  }

  async getPreferences(userId: string, organizationId: string) {
    const membership = await this.prisma.userOrganization.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
      select: { preferences: true },
    });

    if (!membership) {
      throw new NotFoundException('Membership not found');
    }

    return (membership.preferences ?? {}) as Record<string, unknown>;
  }

  async updatePreferences(
    userId: string,
    organizationId: string,
    patch: Record<string, unknown>,
  ) {
    const current = await this.getPreferences(userId, organizationId);
    const merged = { ...current, ...patch };

    await this.prisma.userOrganization.update({
      where: { userId_organizationId: { userId, organizationId } },
      data: { preferences: merged as Prisma.InputJsonValue },
    });

    return merged;
  }
}
