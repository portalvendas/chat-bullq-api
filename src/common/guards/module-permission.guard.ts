import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionGroupsService } from '../../modules/permission-groups/permission-groups.service';
import {
  REQUIRE_MODULE_KEY,
  RequireModuleMeta,
} from '../decorators/require-module.decorator';

/**
 * Aplica @RequireModule(module, action) contra as permissões efetivas do
 * usuário na org. Deve rodar DEPOIS de JwtAuthGuard + OrgGuard (usa
 * request.user.id e request.organization.id). Sem decorator → libera.
 */
@Injectable()
export class ModulePermissionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly perms: PermissionGroupsService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const meta = this.reflector.getAllAndOverride<RequireModuleMeta | undefined>(
      REQUIRE_MODULE_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (!meta) return true;

    const req = ctx.switchToHttp().getRequest();
    const userId = req.user?.id;
    const orgId = req.organization?.id ?? req.headers['x-organization-id'];
    if (!userId || !orgId) throw new ForbiddenException('Sessão inválida.');

    const eff = await this.perms.resolveEffective(userId, orgId);
    if (!eff) throw new ForbiddenException('Sem acesso à organização.');
    if (eff.fullAccess) return true;

    const m = eff.modules[meta.module];
    if (m && m[meta.action]) return true;
    throw new ForbiddenException(
      `Sem permissão (${meta.module}:${meta.action}).`,
    );
  }
}
