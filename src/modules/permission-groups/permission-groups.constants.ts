/** Módulos (telas) governados pelo RBAC. Chave estável + rótulo pt-BR. */
export const RBAC_MODULES = [
  { key: 'inbox', label: 'Inbox / Conversas' },
  { key: 'pipelines', label: 'Funil de Vendas' },
  { key: 'marketplaces', label: 'Marketplaces' },
  { key: 'salesbots', label: 'Salesbots' },
  { key: 'jarvis', label: 'Agentes de IA (Jarvis)' },
  { key: 'automations', label: 'Automações' },
  { key: 'dashboard', label: 'Dashboard' },
  { key: 'contacts', label: 'Contatos' },
  { key: 'templates', label: 'Modelos (WhatsApp)' },
  { key: 'knowledge', label: 'Base de Conhecimento' },
  { key: 'settings', label: 'Configurações' },
] as const;

export type RbacModuleKey = (typeof RBAC_MODULES)[number]['key'];

export interface ModulePerm {
  view: boolean;
  edit: boolean;
  delete: boolean;
}
export type ModulePerms = Record<string, ModulePerm>;

export interface EffectivePermissions {
  role: 'OWNER' | 'ADMIN' | 'AGENT';
  fullAccess: boolean;
  permissionGroupId: string | null;
  modules: ModulePerms;
  channels: { all: boolean; ids: string[] };
  pipelines: { all: boolean; ids: string[] };
}

const ALL_KEYS = RBAC_MODULES.map((m) => m.key);

export function everyModule(perm: ModulePerm): ModulePerms {
  return Object.fromEntries(ALL_KEYS.map((k) => [k, { ...perm }]));
}

/** Baseline de AGENTE sem grupo: vê/edita tudo menos Configurações; não exclui. */
export function defaultAgentModules(): ModulePerms {
  const base = everyModule({ view: true, edit: true, delete: false });
  base.settings = { view: false, edit: false, delete: false };
  return base;
}

/** Normaliza um JSON cru de modulePerms para o shape completo (default false). */
export function normalizeModules(raw: unknown): ModulePerms {
  const src = (raw ?? {}) as Record<string, any>;
  return Object.fromEntries(
    ALL_KEYS.map((k) => {
      const v = src[k] ?? {};
      return [k, { view: !!v.view, edit: !!v.edit, delete: !!v.delete }];
    }),
  );
}
