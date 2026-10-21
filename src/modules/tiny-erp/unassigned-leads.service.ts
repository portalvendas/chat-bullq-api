import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { LeadDistributionService } from '../lead-distribution/lead-distribution.service';

/** Como o card nasceu (derivado do metadata/conversa). */
export type LeadEntrada =
  | 'marketplace'
  | 'lead_ads'
  | 'landing_page'
  | 'whatsapp'
  | 'automacao'
  | 'importacao'
  | 'manual';

/** Por que ficou sem vendedor (diagnóstico acionável). */
export type MotivoSemVendedor =
  | 'conversa_com_vendedor'
  | 'marketplace'
  | 'automacao'
  | 'importacao'
  | 'distribuicao_desligada'
  | 'funil_sem_regra'
  | 'regra_sem_vendedor'
  | 'nao_distribuido';

export const MOTIVO_LABEL: Record<MotivoSemVendedor, string> = {
  conversa_com_vendedor:
    'A conversa já tem vendedor, mas o card não herdou — use "Distribuir agora" para corrigir',
  marketplace: 'Funil de marketplace (ML/Shopee) — não passa pela distribuição',
  automacao: 'Criado por automação — não passa pela distribuição',
  importacao: 'Importado (Kommo) sem responsável',
  distribuicao_desligada: 'Distribuição de leads desligada',
  funil_sem_regra: 'Funil sem regra de distribuição (nem regra padrão)',
  regra_sem_vendedor: 'Regra do funil sem vendedor com peso',
  nao_distribuido: 'Criado manualmente sem responsável (ou antes da regra existir)',
};

interface CardMeta {
  source?: string;
  createdBy?: string;
  tracking?: Record<string, unknown>;
  leadgenId?: string;
}

/**
 * Leads (cards) do período SEM VENDEDOR responsável — drill-down do "Sem
 * vendedor" da tabela Por vendedor, com o MOTIVO de cada um.
 *
 * O motivo cruza como o card nasceu com a config de distribuição ATUAL:
 *  - marketplace / automação / importação não chamam a distribuição;
 *  - os demais passam por `assignEntry`; se ficaram sem dono é porque a
 *    distribuição estava desligada, o funil não tem regra (nem "*"), a regra
 *    não tem vendedor com peso — ou o card foi criado à mão/antes da regra.
 */
@Injectable()
export class UnassignedLeadsService {
  private readonly logger = new Logger(UnassignedLeadsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly distribution: LeadDistributionService,
  ) {}

  private entrada(meta: CardMeta, hasInboundBefore: boolean): LeadEntrada {
    if (meta.source === 'marketplace-sync') return 'marketplace';
    if (meta.source === 'facebook_leadads' || meta.leadgenId) return 'lead_ads';
    if (meta.source === 'import_kommo') return 'importacao';
    if (meta.createdBy === 'automation') return 'automacao';
    if (hasInboundBefore) return 'whatsapp';
    if (meta.tracking && Object.keys(meta.tracking).length) return 'landing_page';
    return 'manual';
  }

  /**
   * GET /tiny/leads-unassigned?from&to&page&limit →
   * { items: [{ cardId, name, phone, pipeline, stage, status, entrada, motivo,
   *             motivoLabel, conversationId, createdAt }],
   *   breakdown: { porMotivo: [{motivo,label,count}], porFunil: [{pipeline,count}] },
   *   distribution: { enabled, funisSemRegra: [...] },
   *   pagination: { page, limit, total, totalPages } }
   */
  async list(
    organizationId: string,
    range: { gte?: Date; lte?: Date } | undefined,
    page = 1,
    limit = 50,
  ) {
    const take = Math.min(Math.max(limit, 1), 200);
    const skip = (Math.max(page, 1) - 1) * take;
    const where: Prisma.CardWhereInput = {
      organizationId,
      assignedToId: null,
      ...(range ? { createdAt: range } : {}),
    };

    const [cfg, pipelines] = await Promise.all([
      this.distribution.getConfig(organizationId),
      this.prisma.pipeline.findMany({
        where: { organizationId },
        select: { id: true, name: true },
      }),
    ]);
    const pipelineName = new Map(pipelines.map((p) => [p.id, p.name]));
    const ruleFor = (pipelineId: string) =>
      cfg.rules.find((r) => r.pipelineId === pipelineId) ??
      cfg.rules.find((r) => r.pipelineId === '*') ??
      null;
    const motivoDistribuicao = (pipelineId: string): MotivoSemVendedor => {
      if (!cfg.enabled) return 'distribuicao_desligada';
      const rule = ruleFor(pipelineId);
      if (!rule) return 'funil_sem_regra';
      if (!rule.weights.some((w) => w.userId && (w.weight ?? 0) > 0)) return 'regra_sem_vendedor';
      return 'nao_distribuido';
    };

    const [total, cards, groups] = await Promise.all([
      this.prisma.card.count({ where }),
      this.prisma.card.findMany({
        where,
        select: {
          id: true,
          title: true,
          status: true,
          createdAt: true,
          pipelineId: true,
          conversationId: true,
          metadata: true,
          stage: { select: { name: true } },
          contact: { select: { id: true, name: true, phone: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      // Breakdown do período INTEIRO (não só da página): funil × origem.
      this.prisma.$queryRaw<{ pipelineId: string; source: string | null; createdBy: string | null; convOwner: boolean; n: number }[]>`
        SELECT k.pipeline_id AS "pipelineId",
               k.metadata->>'source' AS source,
               k.metadata->>'createdBy' AS "createdBy",
               EXISTS (
                 SELECT 1 FROM conversations cv
                 WHERE cv.contact_id = k.contact_id AND cv.organization_id = k.organization_id
                   AND cv.assigned_to_id IS NOT NULL
               ) AS "convOwner",
               COUNT(*)::int AS n
        FROM cards k
        WHERE k.organization_id = ${organizationId}
          AND k.assigned_to_id IS NULL
          ${range?.gte ? Prisma.sql`AND k.created_at >= (${range.gte.toISOString()}::timestamptz AT TIME ZONE 'UTC')` : Prisma.empty}
          ${range?.lte ? Prisma.sql`AND k.created_at <= (${range.lte.toISOString()}::timestamptz AT TIME ZONE 'UTC')` : Prisma.empty}
        GROUP BY 1, 2, 3, 4`,
    ]);

    // Motivo a partir de origem + config (mesma regra para página e breakdown).
    // 1º: se a CONVERSA do contato já tem vendedor, o problema é só o card
    // não ter herdado (não é a distribuição).
    const motivoOf = (pipelineId: string, meta: CardMeta, convOwner = false): MotivoSemVendedor => {
      if (convOwner) return 'conversa_com_vendedor';
      if (meta.source === 'marketplace-sync') return 'marketplace';
      if (meta.createdBy === 'automation') return 'automacao';
      if (meta.source === 'import_kommo') return 'importacao';
      return motivoDistribuicao(pipelineId);
    };

    const porMotivoMap = new Map<MotivoSemVendedor, number>();
    const porFunilMap = new Map<string, number>();
    for (const g of groups) {
      const m = motivoOf(g.pipelineId, { source: g.source ?? undefined, createdBy: g.createdBy ?? undefined }, g.convOwner);
      porMotivoMap.set(m, (porMotivoMap.get(m) ?? 0) + g.n);
      const pn = pipelineName.get(g.pipelineId) ?? 'Funil removido';
      porFunilMap.set(pn, (porFunilMap.get(pn) ?? 0) + g.n);
    }

    // Entrada por WhatsApp: houve INBOUND do contato até 2 min depois do card.
    const contactIds = [...new Set(cards.map((c) => c.contact?.id).filter((x): x is string => !!x))];
    const firstInbound = new Map<string, Date>();
    if (contactIds.length) {
      try {
        const rows = await this.prisma.$queryRaw<{ contactId: string; first: Date }[]>`
          SELECT c.contact_id AS "contactId", MIN(m.created_at) AS first
          FROM conversations c JOIN messages m ON m.conversation_id = c.id
          WHERE c.organization_id = ${organizationId}
            AND c.contact_id IN (${Prisma.join(contactIds)})
            AND m.direction = 'INBOUND'
          GROUP BY 1`;
        for (const r of rows) firstInbound.set(r.contactId, new Date(r.first));
      } catch (err: any) {
        this.logger.warn(`1º inbound por contato falhou: ${err?.message ?? err}`);
      }
    }
    const latestConv = new Map<string, string>();
    const convSeller = new Map<string, string>(); // contato → vendedor da conversa
    if (contactIds.length) {
      const convs = await this.prisma.conversation.findMany({
        where: { organizationId, contactId: { in: contactIds } },
        select: { id: true, contactId: true, assignedTo: { select: { name: true } } },
        orderBy: { lastMessageAt: 'desc' },
      });
      for (const cv of convs) {
        if (!latestConv.has(cv.contactId)) latestConv.set(cv.contactId, cv.id);
        if (cv.assignedTo?.name && !convSeller.has(cv.contactId)) convSeller.set(cv.contactId, cv.assignedTo.name);
      }
    }

    const EPS_MS = 2 * 60 * 1000;
    const items = cards.map((c) => {
      const meta = (c.metadata ?? {}) as CardMeta;
      const cid = c.contact?.id ?? null;
      const fi = cid ? firstInbound.get(cid) : undefined;
      const vendedorConversa = cid ? convSeller.get(cid) ?? null : null;
      const motivo = motivoOf(c.pipelineId, meta, !!vendedorConversa);
      return {
        cardId: c.id,
        name: c.contact?.name ?? c.title ?? null,
        phone: c.contact?.phone ?? null,
        pipelineId: c.pipelineId,
        pipeline: pipelineName.get(c.pipelineId) ?? null,
        stage: c.stage?.name ?? null,
        status: c.status,
        entrada: this.entrada(meta, !!fi && fi.getTime() <= c.createdAt.getTime() + EPS_MS),
        motivo,
        motivoLabel:
          motivo === 'conversa_com_vendedor'
            ? `Na conversa está com ${vendedorConversa}, mas o card ficou sem vendedor`
            : MOTIVO_LABEL[motivo],
        vendedorConversa,
        conversationId: c.conversationId ?? (cid ? latestConv.get(cid) ?? null : null),
        createdAt: c.createdAt.toISOString(),
      };
    });

    const funisSemRegra = !cfg.enabled
      ? []
      : pipelines.filter((p) => !ruleFor(p.id)).map((p) => p.name);

    return {
      items,
      breakdown: {
        porMotivo: [...porMotivoMap.entries()]
          .map(([motivo, count]) => ({ motivo, label: MOTIVO_LABEL[motivo], count }))
          .sort((a, b) => b.count - a.count),
        porFunil: [...porFunilMap.entries()]
          .map(([pipeline, count]) => ({ pipeline, count }))
          .sort((a, b) => b.count - a.count),
      },
      distribution: { enabled: cfg.enabled, funisSemRegra },
      pagination: {
        page: Math.max(page, 1),
        limit: take,
        total,
        totalPages: Math.ceil(total / take),
      },
    };
  }
}
