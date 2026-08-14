import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export interface LeadWeight {
  userId: string;
  weight: number;
}
/** Regra de distribuição de UM funil. pipelineId "*" = padrão dos demais. */
export interface PipelineRule {
  pipelineId: string;
  weights: LeadWeight[];
}
export interface LeadDistributionConfigInput {
  enabled?: boolean;
  /** Regras por funil. Cada funil tem sua própria classificação de pesos. */
  rules?: PipelineRule[];
}

/** Coringa de regra aplicada aos funis sem configuração própria. */
const DEFAULT_RULE = '*';

/**
 * Orquestrador de leads: distribui cada lead novo (conversa sem responsável)
 * entre vendedores por SORTEIO PONDERADO. Os pesos são POR FUNIL — cada funil
 * tem sua própria classificação (ex.: Mercado Livre 100% p/ um vendedor; Funil
 * de Vendas 70/30). Uma regra "*" pode servir de padrão pros demais funis.
 */
@Injectable()
export class LeadDistributionService {
  private readonly logger = new Logger(LeadDistributionService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Config ─────────────────────────────────────────────────────────

  /** Normaliza as regras persistidas, com fallback do formato legado. */
  private readRules(cfg: {
    pipelineWeights?: unknown;
    weights?: unknown;
  } | null): PipelineRule[] {
    const raw = (cfg?.pipelineWeights as unknown as PipelineRule[]) ?? [];
    const rules = raw
      .filter((r) => r?.pipelineId)
      .map((r) => ({
        pipelineId: r.pipelineId,
        weights: (r.weights ?? []).filter((w) => w?.userId),
      }));
    // Compat: se ainda não migrou e há pesos globais legados, expõe como "*".
    if (!rules.length) {
      const legacy = ((cfg?.weights as unknown as LeadWeight[]) ?? []).filter(
        (w) => w?.userId,
      );
      if (legacy.length) return [{ pipelineId: DEFAULT_RULE, weights: legacy }];
    }
    return rules;
  }

  async getConfig(organizationId: string) {
    const c = await this.prisma.leadDistributionConfig.findUnique({
      where: { organizationId },
    });
    return {
      enabled: c?.enabled ?? false,
      rules: this.readRules(c),
    };
  }

  async updateConfig(organizationId: string, dto: LeadDistributionConfigInput) {
    const data: any = {
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.rules !== undefined
        ? {
            pipelineWeights: dto.rules
              .filter((r) => r?.pipelineId)
              .map((r) => ({
                pipelineId: r.pipelineId,
                weights: (r.weights ?? [])
                  .filter((w) => w?.userId)
                  .map((w) => ({
                    userId: w.userId,
                    weight: Number(w.weight) || 0,
                  })),
              }))
              // descarta regras sem nenhum peso > 0
              .filter((r) => r.weights.some((w) => w.weight > 0)) as any,
          }
        : {}),
    };
    await this.prisma.leadDistributionConfig.upsert({
      where: { organizationId },
      create: { organizationId, ...data },
      update: data,
    });
    return this.getConfig(organizationId);
  }

  /**
   * Lista os VENDEDORES da org = usuários que participam da distribuição
   * (têm peso > 0 em qualquer regra de funil). Usado pelo filtro "Vendedores"
   * do inbox. Retorna id/nome/avatar dos usuários, deduplicados.
   */
  async listSellers(
    organizationId: string,
  ): Promise<Array<{ userId: string; name: string | null; avatarUrl: string | null }>> {
    const cfg = await this.getConfig(organizationId);
    const ids = [
      ...new Set(
        cfg.rules
          .flatMap((r) => r.weights)
          .filter((w) => w?.userId && (w.weight ?? 0) > 0)
          .map((w) => w.userId),
      ),
    ];
    if (!ids.length) return [];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true, avatarUrl: true },
    });
    // Preserva a ordem/deduplicação de `ids` e ignora usuários inexistentes.
    const byId = new Map(users.map((u) => [u.id, u]));
    return ids
      .map((id) => byId.get(id))
      .filter((u): u is { id: string; name: string | null; avatarUrl: string | null } => !!u)
      .map((u) => ({ userId: u.id, name: u.name, avatarUrl: u.avatarUrl }));
  }

  // ── Distribuição ───────────────────────────────────────────────────

  /**
   * Sorteia um vendedor pro funil informado conforme a regra dele (ou a regra
   * padrão "*"). Retorna null se a distribuição está desligada, o funil não tem
   * regra, ou não há membros elegíveis. Fonte de verdade da distribuição
   * ponderada — a distribuição padrão (round-robin) chama isto e, quando volta
   * um userId, deixa o ponderado SOBREPOR.
   */
  async pickForPipeline(
    organizationId: string,
    pipelineId?: string | null,
  ): Promise<string | null> {
    const cfg = await this.prisma.leadDistributionConfig.findUnique({
      where: { organizationId },
    });
    if (!cfg?.enabled) return null;

    const rules = this.readRules(cfg);
    if (!rules.length) return null;

    // Regra específica do funil > regra padrão "*".
    const rule =
      (pipelineId && rules.find((r) => r.pipelineId === pipelineId)) ||
      rules.find((r) => r.pipelineId === DEFAULT_RULE) ||
      null;
    if (!rule) return null;

    const weights = rule.weights.filter(
      (w) => w?.userId && (w.weight ?? 0) > 0,
    );
    if (!weights.length) return null;

    // Só membros ativos da org entram no sorteio.
    const members = await this.prisma.userOrganization.findMany({
      where: { organizationId, userId: { in: weights.map((w) => w.userId) } },
      select: { userId: true },
    });
    const memberSet = new Set(members.map((m) => m.userId));
    const eligible = weights.filter((w) => memberSet.has(w.userId));
    if (!eligible.length) return null;

    return this.pickWeighted(eligible);
  }

  /** Compat: distribuição sem contexto de funil usa a regra padrão "*". */
  async pickForOrg(organizationId: string): Promise<string | null> {
    return this.pickForPipeline(organizationId, null);
  }

  /** Sorteio ponderado: retorna um userId conforme os pesos (>0). */
  private pickWeighted(weights: LeadWeight[]): string | null {
    const valid = weights.filter((w) => w.userId && (w.weight ?? 0) > 0);
    if (!valid.length) return null;
    const total = valid.reduce((s, w) => s + w.weight, 0);
    let r = Math.random() * total;
    for (const w of valid) {
      r -= w.weight;
      if (r < 0) return w.userId;
    }
    return valid[valid.length - 1].userId;
  }

  /**
   * STICKINESS: retorna o vendedor que JÁ é dono deste contato, se houver.
   * Um lead que voltou a falar "gruda" no vendedor que já era dele — não
   * re-sorteia. Fonte da verdade, em ordem: conversa atribuída mais recente
   * do contato → senão card (kanban) atribuído mais recente. Retorna null se
   * o contato ainda não tem dono em lugar nenhum.
   */
  async existingOwnerForContact(
    organizationId: string,
    contactId?: string | null,
  ): Promise<string | null> {
    if (!contactId) return null;
    const conv = await this.prisma.conversation.findFirst({
      where: { organizationId, contactId, assignedToId: { not: null } },
      orderBy: { updatedAt: 'desc' },
      select: { assignedToId: true },
    });
    if (conv?.assignedToId) return conv.assignedToId;
    const card = await this.prisma.card.findFirst({
      where: { organizationId, contactId, assignedToId: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { assignedToId: true },
    });
    return card?.assignedToId ?? null;
  }

  /**
   * Distribui um lead na ENTRADA (criação do card / nova conversa). Regra:
   *  1) STICKINESS — se o contato já tem dono, o lead fica com ele (não sorteia);
   *  2) senão, SORTEIO PONDERADO pela regra do funil do lead.
   * Aplica o responsável na conversa E no card, sempre de forma IDEMPOTENTE
   * (só escreve quando estão sem responsável — nunca rouba um lead já atribuído).
   * Best-effort: nunca lança. Retorna o userId escolhido ou null (sem regra /
   * sem membros elegíveis / lead já tinha dono e nada a fazer).
   */
  async assignEntry(params: {
    organizationId: string;
    contactId?: string | null;
    conversationId?: string | null;
    cardId?: string | null;
    pipelineId?: string | null;
  }): Promise<string | null> {
    const { organizationId, contactId, conversationId, cardId, pipelineId } =
      params;

    // 1) Stickiness tem prioridade sobre o sorteio.
    let userId = await this.existingOwnerForContact(organizationId, contactId);
    let source: 'sticky' | 'weighted' = 'sticky';

    // 2) Sem dono ainda → sorteia pela regra do funil.
    if (!userId) {
      userId = await this.pickForPipeline(organizationId, pipelineId ?? null);
      source = 'weighted';
    }

    if (!userId) {
      this.logger.debug(
        `assignEntry sem vendedor (org=${organizationId} funil=${pipelineId ?? '-'} contato=${contactId ?? '-'}): distribuição off, funil sem regra ou sem membro elegível`,
      );
      return null;
    }

    try {
      if (conversationId) {
        const res = await this.prisma.conversation.updateMany({
          where: { id: conversationId, organizationId, assignedToId: null },
          data: { assignedToId: userId },
        });
        if (res.count > 0) {
          await this.prisma.conversationAuditLog
            .create({
              data: {
                conversationId,
                actorId: null,
                action: 'ASSIGNED',
                fromValue: null,
                toValue: userId,
                metadata: {
                  source: `lead_distribution:${source}`,
                  pipelineId: pipelineId ?? null,
                },
              },
            })
            .catch(() => undefined);
        }
      }

      // Card: o específico quando informado; senão os cards abertos sem dono
      // do contato (cura leads antigos sem responsável).
      if (cardId) {
        await this.prisma.card
          .updateMany({
            where: { id: cardId, organizationId, assignedToId: null },
            data: { assignedToId: userId },
          })
          .catch(() => undefined);
      } else if (contactId) {
        await this.prisma.card
          .updateMany({
            where: {
              organizationId,
              contactId,
              assignedToId: null,
              status: 'OPEN',
            },
            data: { assignedToId: userId },
          })
          .catch(() => undefined);
      }

      this.logger.log(
        `lead_distribuido(${source}) conv=${conversationId ?? '-'} card=${cardId ?? '-'} funil=${pipelineId ?? '-'} -> user=${userId}`,
      );
      return userId;
    } catch (err: any) {
      this.logger.warn(
        `assignEntry falhou (org=${organizationId} conv=${conversationId ?? '-'}): ${err?.message ?? err}`,
      );
      return null;
    }
  }

  /**
   * Atribui um responsável a uma conversa NOVA sem responsável, via sorteio
   * ponderado da regra do FUNIL do lead. Best-effort e idempotente (só age
   * quando assignedToId é null). Também aplica no card do contato quando existir
   * sem responsável.
   */
  async assignConversation(
    organizationId: string,
    conversationId: string,
    pipelineId?: string | null,
  ): Promise<string | null> {
    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId },
      select: { id: true, assignedToId: true, contactId: true, status: true },
    });
    if (!conv || conv.assignedToId) return null;

    const userId = await this.pickForPipeline(organizationId, pipelineId);
    if (!userId) return null;

    try {
      // updateMany com guard assignedToId=null evita corrida (2 mensagens
      // quase simultâneas na mesma conversa nova).
      const res = await this.prisma.conversation.updateMany({
        where: { id: conversationId, organizationId, assignedToId: null },
        data: { assignedToId: userId },
      });
      if (res.count === 0) return null; // outra thread já atribuiu

      await this.prisma.conversationAuditLog
        .create({
          data: {
            conversationId,
            actorId: null,
            action: 'ASSIGNED',
            fromValue: null,
            toValue: userId,
            metadata: { source: 'lead_distribution', pipelineId: pipelineId ?? null },
          },
        })
        .catch(() => undefined);

      // Card do contato (kanban) sem responsável → herda o mesmo vendedor.
      if (conv.contactId) {
        await this.prisma.card
          .updateMany({
            where: {
              organizationId,
              contactId: conv.contactId,
              assignedToId: null,
            },
            data: { assignedToId: userId },
          })
          .catch(() => undefined);
      }

      this.logger.log(
        `lead_distribuido conv=${conversationId} funil=${pipelineId ?? '-'} -> user=${userId}`,
      );
      return userId;
    } catch (err: any) {
      this.logger.warn(
        `assignConversation falhou conv=${conversationId}: ${err?.message ?? err}`,
      );
      return null;
    }
  }
}
