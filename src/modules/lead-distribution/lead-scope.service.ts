import { ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { getTenantContext } from '../../common/tenant/tenant-context';

/** Cache curto da lista de vendedoras por org (evita 1 query por request). */
const CACHE_MS = 60_000;

/**
 * ESCOPO DA VENDEDORA: fora do Kanban, cada vendedora só vê e só aborda os
 * PRÓPRIOS leads (Inbox, "Leads sem resposta", "Iniciar conversa"...).
 *
 * Vendedora = participa da distribuição (peso > 0 em alguma regra ativa) e
 * NÃO é dona da conta. Gestor que não está na distribuição vê tudo. O papel
 * (Admin/Agente) não importa — as vendedoras hoje são Admin.
 *
 * Fora de request HTTP (jobs, webhooks) não há usuário → sem restrição.
 *
 *   restrictedUserId('org') → 'userKelen'  (Kelen logada)
 *   restrictedUserId('org') → null         (Diogo / dono / job)
 */
@Injectable()
export class LeadScopeService {
  private cache = new Map<string, { at: number; sellers: Set<string> }>();

  constructor(private readonly prisma: PrismaService) {}

  async sellerIds(organizationId: string): Promise<Set<string>> {
    const hit = this.cache.get(organizationId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.sellers;
    const cfg = await this.prisma.leadDistributionConfig.findUnique({
      where: { organizationId },
      select: { enabled: true, pipelineWeights: true, weights: true },
    });
    const sellers = new Set<string>();
    if (cfg?.enabled) {
      const rules = ((cfg.pipelineWeights as any[]) ?? []).concat(
        [{ weights: (cfg.weights as any[]) ?? [] }],
      );
      for (const r of rules) {
        for (const w of r?.weights ?? []) if (w?.userId && Number(w.weight) > 0) sellers.add(w.userId);
      }
    }
    this.cache.set(organizationId, { at: Date.now(), sellers });
    return sellers;
  }

  /** Invalida o cache (chamado quando a config de distribuição muda). */
  invalidate(organizationId: string): void {
    this.cache.delete(organizationId);
  }

  /** Id da vendedora logada quando o request deve ser restrito; senão null. */
  async restrictedUserId(organizationId: string): Promise<string | null> {
    const ctx = getTenantContext();
    if (!ctx?.userId || ctx.role === 'OWNER') return null;
    if (ctx.organizationId && ctx.organizationId !== organizationId) return null;
    const sellers = await this.sellerIds(organizationId);
    return sellers.has(ctx.userId) ? ctx.userId : null;
  }

  /**
   * Garante que a vendedora logada pode agir neste lead: dela ou sem dono.
   * Lança 403 com o nome da dona quando é de outra vendedora.
   */
  async assertCanActOn(
    organizationId: string,
    ownerUserId: string | null | undefined,
  ): Promise<void> {
    const me = await this.restrictedUserId(organizationId);
    if (!me || !ownerUserId || ownerUserId === me) return;
    const owner = await this.prisma.user.findUnique({
      where: { id: ownerUserId },
      select: { name: true },
    });
    throw new ForbiddenException(
      `Este lead é da ${owner?.name ?? 'outra vendedora'}. Peça a transferência ao gestor.`,
    );
  }

  /** Filtro SQL de conversa (alias `alias`) visível pra vendedora: dela ou sem dono. */
  conversationScopeSql(alias: string, me: string): Prisma.Sql {
    return Prisma.sql`(${Prisma.raw(alias)}.assigned_to_id = ${me} OR ${Prisma.raw(alias)}.assigned_to_id IS NULL)`;
  }
}
