import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { PlatformRole } from '@prisma/client';

export interface PlatformUser {
  id?: string;
  email?: string;
  platformRole?: PlatformRole | null;
}

/**
 * Lê a allowlist de e-mails de super-admin da env `PLATFORM_ADMIN_EMAILS`
 * (separados por vírgula). Serve APENAS de bootstrap seguro do 1º admin —
 * evita ficar trancado pra fora antes de existir alguém com o papel no banco.
 * A fonte da verdade continua sendo `User.platformRole` no banco.
 */
export function platformAdminAllowlist(): string[] {
  return (process.env.PLATFORM_ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

/** true se o usuário é super-admin de plataforma (papel no banco OU allowlist). */
export function isPlatformAdmin(user?: PlatformUser | null): boolean {
  if (!user) return false;
  if (user.platformRole === PlatformRole.SUPER_ADMIN) return true;
  const email = user.email?.toLowerCase();
  return !!email && platformAdminAllowlist().includes(email);
}

/**
 * Guard do console de super-admin. Usado junto com JwtAuthGuard (NÃO usa
 * OrgGuard — o super-admin opera acima das orgs, sem header x-organization-id).
 * A checagem é sempre fresca: o JwtStrategy recarrega o user do banco a cada
 * request, então revogar o papel tem efeito imediato.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    if (!isPlatformAdmin(request.user)) {
      throw new ForbiddenException('Requer papel de super-admin de plataforma');
    }
    return true;
  }
}
