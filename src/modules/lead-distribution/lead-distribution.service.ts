import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export interface LeadWeight {
  userId: string;
  weight: number;
}
export interface LeadDistributionConfigInput {
  enabled?: boolean;
  weights?: LeadWeight[];
}

/**
 * Orquestrador de leads: distribui cada lead novo (conversa sem responsável)
 * entre vendedores por SORTEIO PONDERADO conforme os pesos configurados.
 * Sem filtro de disponibilidade — respeita só os percentuais.
 */
@Injectable()
export class LeadDistributionService {
  private readonly logger = new Logger(LeadDistributionService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ── Config ─────────────────────────────────────────────────────────

  async getConfig(organizationId: string) {
    const c = await this.prisma.leadDistributionConfig.findUnique({
      where: { organizationId },
    });
    return {
      enabled: c?.enabled ?? false,
      weights: ((c?.weights as LeadWeight[]) ?? []).filter((w) => w?.userId),
    };
  }

  async updateConfig(organizationId: string, dto: LeadDistributionConfigInput) {
    const data: any = {
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.weights !== undefined
        ? {
            weights: dto.weights
              .filter((w) => w?.userId)
              .map((w) => ({ userId: w.userId, weight: Number(w.weight) || 0 })) as any,
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

  // ── Distribuição ───────────────────────────────────────────────────

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
   * Atribui um responsável a uma conversa NOVA sem responsável, via sorteio
   * ponderado. Best-effort e idempotente (só age quando assignedToId é null).
   * Também aplica no card do contato (kanban) quando existir sem responsável.
   */
  async assignConversation(
    organizationId: string,
    conversationId: string,
  ): Promise<string | null> {
    const cfg = await this.prisma.leadDistributionConfig.findUnique({
      where: { organizationId },
    });
    if (!cfg?.enabled) return null;
    const weights = ((cfg.weights as LeadWeight[]) ?? []).filter(
      (w) => w?.userId && (w.weight ?? 0) > 0,
    );
    if (!weights.length) return null;

    const conv = await this.prisma.conversation.findFirst({
      where: { id: conversationId, organizationId },
      select: { id: true, assignedToId: true, contactId: true, status: true },
    });
    if (!conv || conv.assignedToId) return null;

    // Só sorteia entre vendedores que AINDA são membros da org.
    const members = await this.prisma.userOrganization.findMany({
      where: {
        organizationId,
        userId: { in: weights.map((w) => w.userId) },
      },
      select: { userId: true },
    });
    const memberSet = new Set(members.map((m) => m.userId));
    const eligible = weights.filter((w) => memberSet.has(w.userId));
    if (!eligible.length) return null;

    const userId = this.pickWeighted(eligible);
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
            metadata: { source: 'lead_distribution' },
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
        `lead_distribuido conv=${conversationId} -> user=${userId}`,
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
