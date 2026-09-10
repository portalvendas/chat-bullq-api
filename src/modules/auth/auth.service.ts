import {
  Injectable,
  UnauthorizedException,
  ConflictException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import type { SignOptions } from 'jsonwebtoken';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { RegisterDto } from './dto/register.dto';
import { LoginDto } from './dto/login.dto';
import { isPlatformAdmin } from '../../common/guards';
import { MailService } from '../mail/mail.service';

const BCRYPT_ROUNDS = 12;
/** Validade do token de redefinição de senha (minutos). */
const RESET_TOKEN_TTL_MIN = 60;
/** Máx. de solicitações de reset por usuário dentro da janela de validade. */
const RESET_MAX_ACTIVE = 3;
/** Throttle em memória por IP p/ solicitação de reset (best-effort). */
const RESET_IP_WINDOW_MS = 15 * 60 * 1000;
const RESET_IP_MAX = 5;
const resetIpHits = new Map<string, number[]>();

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly config: ConfigService,
    private readonly mail: MailService,
  ) {}

  async register(dto: RegisterDto) {
    const hashedPassword = await bcrypt.hash(dto.password, BCRYPT_ROUNDS);

    // Convite: o fluxo TOLERA e-mail já existente (ex.: usuário que sobrou de
    // uma empresa excluída). Reaproveita/atualiza o acesso em vez de barrar com
    // "Email already registered".
    if (dto.inviteToken) {
      return this.registerWithInvite(dto, hashedPassword);
    }

    // Cadastro aberto (sem convite): e-mail precisa ser inédito.
    const existing = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existing) {
      throw new ConflictException('Email already registered');
    }

    // Cadastro aberto (self-service) pode ser desligado por env: com
    // SELF_SERVICE_SIGNUP=invite_only, só entra quem tem convite — inclusão de
    // empresas passa a ser 100% provisionada pelo super-admin.
    if (process.env.SELF_SERVICE_SIGNUP === 'invite_only') {
      throw new ForbiddenException(
        'Cadastro aberto desabilitado. Solicite um convite ao administrador.',
      );
    }

    return this.registerNewWorkspace(dto, hashedPassword);
  }

  private async registerNewWorkspace(dto: RegisterDto, hashedPassword: string) {
    const slug = this.generateSlug(dto.name);

    const result = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          name: dto.name,
          email: dto.email,
          password: hashedPassword,
        },
      });

      const organization = await tx.organization.create({
        data: {
          name: `${dto.name}'s Workspace`,
          slug,
        },
      });

      await tx.userOrganization.create({
        data: {
          userId: user.id,
          organizationId: organization.id,
          role: 'OWNER',
        },
      });

      const defaultDepartment = await tx.department.create({
        data: {
          organizationId: organization.id,
          name: 'Geral',
          description: 'Departamento padrão',
          isDefault: true,
        },
      });

      const userOrg = await tx.userOrganization.findUnique({
        where: {
          userId_organizationId: {
            userId: user.id,
            organizationId: organization.id,
          },
        },
      });

      if (userOrg) {
        await tx.departmentAgent.create({
          data: {
            departmentId: defaultDepartment.id,
            userOrganizationId: userOrg.id,
          },
        });
      }

      return { user, organization };
    });

    const tokens = await this.generateTokens(result.user.id, result.user.email);
    this.logger.log(`User registered (new workspace): ${result.user.email}`);

    return {
      user: this.sanitizeUser(result.user),
      organizations: [{
        id: result.organization.id,
        name: result.organization.name,
        slug: result.organization.slug,
        role: 'OWNER',
        accessibleChannelIds: 'ALL' as const,
      }],
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  private async registerWithInvite(dto: RegisterDto, hashedPassword: string) {
    // Validate the invitation
    const invitation = await this.prisma.invitation.findUnique({
      where: { token: dto.inviteToken },
      include: { organization: true },
    });

    if (!invitation) {
      throw new BadRequestException('Invalid invitation token');
    }
    if (invitation.status !== 'PENDING' && invitation.status !== 'ACCEPTED') {
      throw new BadRequestException(`Invitation has already been ${invitation.status.toLowerCase()}`);
    }
    if (invitation.expiresAt < new Date()) {
      throw new BadRequestException('Invitation has expired');
    }
    if (invitation.email !== dto.email) {
      throw new BadRequestException('Email does not match the invitation');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      // Reaproveita o usuário quando o e-mail já existe (ex.: sobra de uma
      // empresa excluída). Como o convite é um segredo entregue pelo admin ao
      // próprio convidado, definir a senha aqui é seguro (equivale a um reset
      // via link) e reativa a conta se estava inativa/removida.
      const existing = await tx.user.findUnique({ where: { email: dto.email } });
      const user = existing
        ? await tx.user.update({
            where: { id: existing.id },
            data: {
              name: dto.name || existing.name,
              password: hashedPassword,
              isActive: true,
              deletedAt: null,
            },
          })
        : await tx.user.create({
            data: {
              name: dto.name,
              email: dto.email,
              password: hashedPassword,
            },
          });

      // Vincula à empresa do convite (idempotente: não duplica se já for membro).
      let membership = await tx.userOrganization.findUnique({
        where: {
          userId_organizationId: {
            userId: user.id,
            organizationId: invitation.organizationId,
          },
        },
      });
      if (!membership) {
        membership = await tx.userOrganization.create({
          data: {
            userId: user.id,
            organizationId: invitation.organizationId,
            role: invitation.role,
          },
        });
      }

      // Garante o vínculo ao departamento padrão (idempotente).
      const defaultDept = await tx.department.findFirst({
        where: { organizationId: invitation.organizationId, isDefault: true },
      });
      if (defaultDept) {
        const existingAgent = await tx.departmentAgent.findFirst({
          where: {
            departmentId: defaultDept.id,
            userOrganizationId: membership.id,
          },
        });
        if (!existingAgent) {
          await tx.departmentAgent.create({
            data: {
              departmentId: defaultDept.id,
              userOrganizationId: membership.id,
            },
          });
        }
      }

      // Marca o convite como aceito.
      await tx.invitation.update({
        where: { id: invitation.id },
        data: { status: 'ACCEPTED', acceptedAt: new Date() },
      });

      // Expira outros convites pendentes para o mesmo e-mail.
      await tx.invitation.updateMany({
        where: {
          email: dto.email,
          status: 'PENDING',
          id: { not: invitation.id },
        },
        data: { status: 'EXPIRED' },
      });

      return { user, organization: invitation.organization };
    });

    const tokens = await this.generateTokens(result.user.id, result.user.email);
    this.logger.log(`User registered via invitation: ${result.user.email} -> org ${result.organization.name}`);

    return {
      user: this.sanitizeUser(result.user),
      organizations: [{
        id: result.organization.id,
        name: result.organization.name,
        slug: result.organization.slug,
        role: invitation.role,
        // New invited members start with no channel grants (deny-by-default).
        // OWNER/ADMIN bypass; AGENT must be explicitly granted by an admin.
        accessibleChannelIds:
          invitation.role === 'OWNER' || invitation.role === 'ADMIN'
            ? ('ALL' as const)
            : ([] as string[]),
      }],
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async login(dto: LoginDto) {
    const user = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });

    if (!user) {
      throw new UnauthorizedException('Invalid credentials');
    }

    const passwordValid = await bcrypt.compare(dto.password, user.password);
    if (!passwordValid) {
      throw new UnauthorizedException('Invalid credentials');
    }

    if (!user.isActive) {
      throw new UnauthorizedException('Account is deactivated');
    }

    const memberships = await this.prisma.userOrganization.findMany({
      where: { userId: user.id },
      include: {
        organization: true,
        channelAgents: { select: { channelId: true } },
      },
    });

    const tokens = await this.generateTokens(user.id, user.email);

    this.logger.log(`User logged in: ${user.email}`);

    return {
      user: this.sanitizeUser(user),
      isPlatformAdmin: isPlatformAdmin(user),
      organizations: memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        role: m.role,
        accessibleChannelIds:
          m.role === 'OWNER' || m.role === 'ADMIN'
            ? ('ALL' as const)
            : m.channelAgents.map((c) => c.channelId),
      })),
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  }

  async refresh(refreshToken: string) {
    try {
      const payload = this.jwt.verify<{ sub: string; iat?: number }>(refreshToken, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
      });

      const user = await this.prisma.user.findUnique({
        where: { id: payload.sub },
      });

      if (!user || !user.isActive) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      // Sessão invalidada por troca de senha: refresh tokens antigos morrem.
      if (this.tokenIssuedBeforePasswordChange(payload.iat, user.passwordChangedAt)) {
        throw new UnauthorizedException('Invalid refresh token');
      }

      return this.generateTokens(user.id, user.email);
    } catch {
      throw new UnauthorizedException('Invalid refresh token');
    }
  }

  // ── Recuperação de senha ────────────────────────────────────────────

  /**
   * Solicita a redefinição de senha. Resposta SEMPRE genérica (não revela se o
   * e-mail existe — anti-enumeração). Gera um token de uso único, guarda só o
   * hash, e envia o link por e-mail. Invalida tokens anteriores do usuário.
   */
  async requestPasswordReset(email: string, ip?: string | null): Promise<{ ok: true }> {
    const generic = { ok: true as const };
    const target = (email || '').trim();
    if (!target) return generic;

    if (ip && this.tooManyResetRequests(ip)) {
      this.logger.warn(`Reset de senha throttled por IP ${ip}`);
      return generic;
    }

    const user = await this.prisma.user.findUnique({ where: { email: target } });
    if (!user || !user.isActive || user.deletedAt) return generic;

    // Limite de solicitações por usuário na janela de validade (anti-flood).
    const since = new Date(Date.now() - RESET_TOKEN_TTL_MIN * 60 * 1000);
    const recent = await this.prisma.passwordResetToken.count({
      where: { userId: user.id, createdAt: { gte: since } },
    });
    if (recent >= RESET_MAX_ACTIVE) {
      this.logger.warn(`Reset de senha: limite de solicitações p/ user ${user.id}`);
      return generic;
    }

    // Só o token mais novo vale: invalida os pendentes anteriores.
    await this.prisma.passwordResetToken.updateMany({
      where: { userId: user.id, usedAt: null },
      data: { usedAt: new Date() },
    });

    const rawToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_MIN * 60 * 1000);
    await this.prisma.passwordResetToken.create({
      data: {
        userId: user.id,
        tokenHash: this.hashToken(rawToken),
        expiresAt,
        requestedIp: ip ?? null,
      },
    });

    await this.mail.sendPasswordReset({
      to: user.email,
      token: rawToken,
      minutes: RESET_TOKEN_TTL_MIN,
    });
    this.logger.log(`Reset de senha solicitado p/ ${user.email}`);
    return generic;
  }

  /** Diz ao front se o token do link ainda é válido (form vs. "link expirado"). */
  async validateResetToken(rawToken: string): Promise<{ valid: boolean }> {
    const rec = await this.findValidResetToken(rawToken);
    return { valid: !!rec };
  }

  /**
   * Redefine a senha a partir do token do e-mail. Uso único: marca o token e
   * todos os pendentes como usados, atualiza a senha e carimba passwordChangedAt
   * (encerra todas as sessões). Envia confirmação por e-mail.
   */
  async resetPassword(rawToken: string, newPassword: string): Promise<{ ok: true }> {
    const rec = await this.findValidResetToken(rawToken);
    if (!rec) {
      throw new BadRequestException('Token inválido ou expirado. Solicite um novo link.');
    }

    const hashedPassword = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.user.update({
        where: { id: rec.userId },
        data: { password: hashedPassword, passwordChangedAt: now, isActive: true },
      }),
      this.prisma.passwordResetToken.updateMany({
        where: { userId: rec.userId, usedAt: null },
        data: { usedAt: now },
      }),
    ]);

    const user = await this.prisma.user.findUnique({ where: { id: rec.userId } });
    if (user) await this.mail.sendPasswordChanged({ to: user.email });
    this.logger.log(`Senha redefinida p/ user ${rec.userId}`);
    return { ok: true };
  }

  private hashToken(raw: string): string {
    return crypto.createHash('sha256').update(raw).digest('hex');
  }

  private async findValidResetToken(rawToken: string) {
    const raw = (rawToken || '').trim();
    if (raw.length < 10) return null;
    const rec = await this.prisma.passwordResetToken.findUnique({
      where: { tokenHash: this.hashToken(raw) },
    });
    if (!rec || rec.usedAt || rec.expiresAt < new Date()) return null;
    return rec;
  }

  private tooManyResetRequests(ip: string): boolean {
    const now = Date.now();
    const arr = (resetIpHits.get(ip) ?? []).filter((t) => now - t < RESET_IP_WINDOW_MS);
    arr.push(now);
    resetIpHits.set(ip, arr);
    return arr.length > RESET_IP_MAX;
  }

  /** True quando o JWT foi emitido ANTES da última troca de senha (5s de folga). */
  private tokenIssuedBeforePasswordChange(
    iat: number | undefined,
    changedAt: Date | null,
  ): boolean {
    if (!changedAt || !iat) return false;
    return iat * 1000 + 5000 < changedAt.getTime();
  }

  async getMe(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
    });

    if (!user) throw new UnauthorizedException();

    const memberships = await this.prisma.userOrganization.findMany({
      where: { userId },
      include: {
        organization: true,
        channelAgents: { select: { channelId: true } },
      },
    });

    return {
      user: this.sanitizeUser(user),
      // Bootstrap por allowlist (PLATFORM_ADMIN_EMAILS) OU papel no banco — o
      // frontend usa essa flag pra liberar o console de super-admin.
      isPlatformAdmin: isPlatformAdmin(user),
      organizations: memberships.map((m) => ({
        id: m.organization.id,
        name: m.organization.name,
        slug: m.organization.slug,
        role: m.role,
        // 'ALL' for OWNER/ADMIN — they bypass the per-channel allowlist.
        accessibleChannelIds:
          m.role === 'OWNER' || m.role === 'ADMIN'
            ? ('ALL' as const)
            : m.channelAgents.map((c) => c.channelId),
      })),
    };
  }

  private async generateTokens(userId: string, email: string) {
    const payload = { sub: userId, email };

    const [accessToken, refreshToken] = await Promise.all([
      this.jwt.signAsync(payload, {
        secret: this.config.get<string>('JWT_SECRET'),
        expiresIn: this.config.get<string>('JWT_EXPIRATION', '15m') as SignOptions['expiresIn'],
      }),
      this.jwt.signAsync(payload, {
        secret: this.config.get<string>('JWT_REFRESH_SECRET'),
        expiresIn: this.config.get<string>('JWT_REFRESH_EXPIRATION', '7d') as SignOptions['expiresIn'],
      }),
    ]);

    return { accessToken, refreshToken };
  }

  private sanitizeUser(user: { password: string; [key: string]: unknown }) {
    const { password: _, ...rest } = user;
    return rest;
  }

  private generateSlug(name: string): string {
    const base = name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');

    return `${base}-${Date.now().toString(36)}`;
  }
}
