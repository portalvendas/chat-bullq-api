import { SetMetadata } from '@nestjs/common';

export type ModuleAction = 'view' | 'edit' | 'delete';
export interface RequireModuleMeta {
  module: string;
  action: ModuleAction;
}
export const REQUIRE_MODULE_KEY = 'requireModule';

/**
 * Exige que o usuário tenha a permissão `action` no módulo RBAC `module`.
 * OWNER/ADMIN passam sempre (fullAccess). Usar com ModulePermissionGuard.
 */
export const RequireModule = (module: string, action: ModuleAction) =>
  SetMetadata(REQUIRE_MODULE_KEY, { module, action } as RequireModuleMeta);
