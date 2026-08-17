import { TENANT_MODELS, SET_ACTIONS, whereMentionsOrg } from './tenant-models';

/**
 * Testes do tenant-guard (multi-empresa). Rodam sem banco.
 * Cobrem a heurística que detecta queries de tenant SEM filtro de org.
 */
describe('tenant-models / tenant-guard helpers', () => {
  it('detecta organizationId no topo do where', () => {
    expect(whereMentionsOrg({ organizationId: 'org_1' })).toBe(true);
    expect(whereMentionsOrg({ organizationId: 'org_1', status: 'OPEN' })).toBe(true);
  });

  it('detecta organizationId dentro de AND/OR/NOT', () => {
    expect(whereMentionsOrg({ AND: [{ status: 'OPEN' }, { organizationId: 'o' }] })).toBe(true);
    expect(whereMentionsOrg({ OR: [{ organizationId: 'o' }] })).toBe(true);
    expect(whereMentionsOrg({ NOT: { organizationId: 'o' } })).toBe(true);
  });

  it('marca como SEM org quando não há organizationId', () => {
    expect(whereMentionsOrg({ id: 'x' })).toBe(false);
    expect(whereMentionsOrg({ status: 'OPEN' })).toBe(false);
    expect(whereMentionsOrg({})).toBe(false);
    expect(whereMentionsOrg(undefined)).toBe(false);
  });

  it('cataloga modelos de tenant e ações de conjunto', () => {
    ['Conversation', 'Card', 'Contact', 'Channel'].forEach((m) =>
      expect(TENANT_MODELS.has(m)).toBe(true),
    );
    // User NÃO é tenant-scoped (é global, entra em orgs via UserOrganization)
    expect(TENANT_MODELS.has('User')).toBe(false);
    ['findMany', 'updateMany', 'deleteMany'].forEach((a) =>
      expect(SET_ACTIONS.has(a)).toBe(true),
    );
    // findUnique fica de fora (chave única; padrão é buscar por id e assertar org)
    expect(SET_ACTIONS.has('findUnique')).toBe(false);
  });
});

/**
 * E2E cross-org (a fazer, precisa de app + banco de teste):
 * - criar org A (owner userA) e org B (owner userB) via /auth/register
 * - userA tenta GET /conversations/:id de um recurso da org B (header
 *   x-organization-id = A) → esperar 403/404 (nunca dados da B)
 * - userA tenta usar x-organization-id = B (sem ser membro) → 403 no OrgGuard
 * - listar /conversations com A → nunca retornar linha da B
 * Enquanto o e2e não existe, o tenant-guard em modo observação loga no runtime
 * qualquer query de conjunto sem organizationId (grep "[tenant-guard]").
 */
