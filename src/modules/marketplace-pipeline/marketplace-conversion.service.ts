import { Injectable, Logger } from '@nestjs/common';
import { CardStatus, ChannelType, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { RealtimeGateway } from '../realtime/realtime.gateway';
import {
  MarketplaceOrder,
  MarketplaceOrdersService,
} from './marketplace-orders.service';

/** Nome do pipeline (sincronizado com prisma/seed.ts). */
export const MARKETPLACE_PIPELINE_NAME = 'Marketplaces';

/** Etapas referenciadas pela lógica (sincronizadas com o seed). */
const STAGE = {
  RECEIVED: 'Pergunta recebida',
  ANSWERED: 'Respondida',
  SALE: 'Venda',
} as const;

const MARKETPLACE_TYPES: ChannelType[] = [
  ChannelType.MERCADO_LIVRE,
  ChannelType.SHOPEE,
];

/** Só olha conversas dos últimos N dias (limita o volume do cron). */
const LOOKBACK_DAYS = 90;

export interface MarketplaceSyncSummary {
  organizationId: string;
  conversationsScanned: number;
  cardsCreated: number;
  conversions: number;
  buyersWithOrders: number;
}

/**
 * Detecta conversão no funil de marketplace cruzando a PERGUNTA do comprador
 * com um PEDIDO PAGO na API do canal (mesmo buyer_id → venda).
 *
 * ## Análise de fluxo / riscos
 * - API de terceiro cai → MarketplaceOrdersService devolve mapa vazio; o cron
 *   não move nada nesse ciclo e tenta de novo depois (consistência eventual).
 * - Processamento duplicado → idempotente: card por conversa é único; card já
 *   em "Venda" (status WON) não é movido de novo.
 * - buyer_id: ML guarda a conversa como `"{buyerId}:{itemId}"` → prefixo antes
 *   do ":". Shopee guarda o próprio id do comprador. O casamento é por igualdade
 *   de buyer_id entre pergunta e pedido.
 */
@Injectable()
export class MarketplaceConversionService {
  private readonly logger = new Logger(MarketplaceConversionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly orders: MarketplaceOrdersService,
    private readonly realtime: RealtimeGateway,
  ) {}

  /** Extrai o buyer_id do externalId do ContactChannel conforme o canal. */
  private extractBuyerId(externalId: string, type: ChannelType): string {
    if (!externalId) return '';
    if (type === ChannelType.MERCADO_LIVRE) {
      // "{buyerId}:{itemId}" (ou o question_id no fallback legado — não casa
      // com pedido, e tudo bem: só não converte).
      return externalId.split(':')[0] ?? externalId;
    }
    return externalId; // Shopee: id do comprador direto
  }

  /** Roda o sync em todas as orgs que têm o pipeline de Marketplaces. */
  async syncAllOrgs(): Promise<void> {
    const pipelines = await this.prisma.pipeline.findMany({
      where: { name: MARKETPLACE_PIPELINE_NAME, archived: false },
      select: { organizationId: true },
    });
    const orgIds = [...new Set(pipelines.map((p) => p.organizationId))];
    for (const orgId of orgIds) {
      try {
        const s = await this.syncOrg(orgId);
        if (s.cardsCreated > 0 || s.conversions > 0) {
          this.logger.log(
            `Marketplace sync org ${orgId}: +${s.cardsCreated} cards, ${s.conversions} conversões (${s.buyersWithOrders} compradores c/ pedido)`,
          );
        }
      } catch (err: any) {
        this.logger.error(
          `Marketplace sync falhou p/ org ${orgId}: ${err?.message ?? err}`,
        );
      }
    }
  }

  /**
   * Sincroniza os cards de marketplace de uma org e aplica a conversão.
   * @returns resumo com contadores (pronto pro dashboard/log).
   */
  async syncOrg(organizationId: string): Promise<MarketplaceSyncSummary> {
    const summary: MarketplaceSyncSummary = {
      organizationId,
      conversationsScanned: 0,
      cardsCreated: 0,
      conversions: 0,
      buyersWithOrders: 0,
    };

    const pipeline = await this.prisma.pipeline.findFirst({
      where: { organizationId, name: MARKETPLACE_PIPELINE_NAME },
      include: { stages: { orderBy: { order: 'asc' } } },
    });
    if (!pipeline) return summary;

    const stageByName = new Map(pipeline.stages.map((s) => [s.name, s]));
    const stReceived = stageByName.get(STAGE.RECEIVED);
    const stAnswered = stageByName.get(STAGE.ANSWERED);
    const stSale = stageByName.get(STAGE.SALE);
    if (!stReceived || !stSale) {
      this.logger.warn(
        `Pipeline Marketplaces ${pipeline.id} sem etapas esperadas — verifique o seed`,
      );
      return summary;
    }

    // Canais de marketplace ativos da org.
    const channels = await this.prisma.channel.findMany({
      where: {
        organizationId,
        type: { in: MARKETPLACE_TYPES },
        isActive: true,
        deletedAt: null,
      },
    });
    if (channels.length === 0) return summary;
    const channelIds = channels.map((c) => c.id);

    // Índice buyer_id → pedido pago, por canal (uma chamada de API por canal).
    const ordersByChannel = new Map<string, Map<string, MarketplaceOrder>>();
    for (const ch of channels) {
      const map = await this.orders.fetchPaidOrdersByBuyer(ch);
      ordersByChannel.set(ch.id, map);
      summary.buyersWithOrders += map.size;
    }

    // Contador de ordenação por etapa (evita várias queries de max(order)).
    const nextOrder = new Map<string, number>();
    for (const s of pipeline.stages) {
      const count = await this.prisma.card.count({
        where: { pipelineId: pipeline.id, stageId: s.id },
      });
      nextOrder.set(s.id, count);
    }
    const bump = (stageId: string): number => {
      const v = nextOrder.get(stageId) ?? 0;
      nextOrder.set(stageId, v + 1);
      return v;
    };

    const since = new Date(Date.now() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
    const conversations = await this.prisma.conversation.findMany({
      where: {
        organizationId,
        channelId: { in: channelIds },
        deletedAt: null,
        createdAt: { gte: since },
      },
      select: {
        id: true,
        channelId: true,
        firstResponseAt: true,
        contactId: true,
        contact: {
          select: {
            name: true,
            channels: {
              where: { channelId: { in: channelIds } },
              select: { channelId: true, externalId: true },
            },
          },
        },
        cards: {
          where: { pipelineId: pipeline.id },
          select: { id: true, stageId: true, status: true, value: true },
        },
      },
      orderBy: { createdAt: 'desc' },
      take: 2000,
    });

    const channelTypeById = new Map(channels.map((c) => [c.id, c.type]));

    for (const conv of conversations) {
      summary.conversationsScanned++;
      const type = channelTypeById.get(conv.channelId)!;
      const cc = conv.contact?.channels.find(
        (x) => x.channelId === conv.channelId,
      );
      const buyerId = this.extractBuyerId(cc?.externalId ?? '', type);

      // 1) Garante um card pra conversa (idempotente).
      let card = conv.cards[0];
      if (!card) {
        const stage = conv.firstResponseAt ? (stAnswered ?? stReceived) : stReceived;
        const created = await this.prisma.card.create({
          data: {
            organizationId,
            pipelineId: pipeline.id,
            stageId: stage.id,
            title: conv.contact?.name || `Comprador ${buyerId || '—'}`,
            contactId: conv.contactId,
            conversationId: conv.id,
            order: bump(stage.id),
            metadata: { buyerId, source: 'marketplace-sync' },
          },
          select: { id: true, stageId: true, status: true, value: true },
        });
        card = created;
        summary.cardsCreated++;
        this.realtime.emitToOrg(organizationId, 'card:created', {
          card: created,
        });
      }

      // 2) Conversão: buyer_id da pergunta bate com pedido pago?
      if (buyerId && card.status !== CardStatus.WON) {
        const order = ordersByChannel.get(conv.channelId)?.get(buyerId);
        if (order) {
          await this.markAsSale(organizationId, card.id, stSale.id, order, bump);
          summary.conversions++;
          continue;
        }
      }

      // 3) Avanço leve: "Pergunta recebida" → "Respondida" quando já houve
      // resposta. Só esse passo — não mexe em cards mais adiante pra respeitar
      // movimentações manuais do operador.
      if (
        stAnswered &&
        conv.firstResponseAt &&
        card.stageId === stReceived.id &&
        card.status === CardStatus.OPEN
      ) {
        await this.prisma.card.update({
          where: { id: card.id },
          data: { stageId: stAnswered.id, order: bump(stAnswered.id) },
        });
        this.realtime.emitToOrg(organizationId, 'card:moved', {
          cardId: card.id,
          toStageId: stAnswered.id,
          status: CardStatus.OPEN,
        });
      }
    }

    return summary;
  }

  /** Move o card pra "Venda" (WON), grava valor e metadados do pedido. */
  private async markAsSale(
    organizationId: string,
    cardId: string,
    saleStageId: string,
    order: MarketplaceOrder,
    bump: (stageId: string) => number,
  ): Promise<void> {
    const existing = await this.prisma.card.findUnique({
      where: { id: cardId },
      select: { metadata: true },
    });
    const meta =
      (existing?.metadata as Prisma.JsonObject | null) ?? ({} as Prisma.JsonObject);

    await this.prisma.card.update({
      where: { id: cardId },
      data: {
        stageId: saleStageId,
        status: CardStatus.WON,
        value: new Prisma.Decimal(order.total.toFixed(2)),
        currency: order.currency || 'BRL',
        closedAt: new Date(),
        closedReason: `Pedido ${order.orderId}`,
        order: bump(saleStageId),
        metadata: {
          ...meta,
          conversion: {
            orderId: order.orderId,
            buyerId: order.buyerId,
            total: order.total,
            currency: order.currency,
            matchedAt: new Date().toISOString(),
          },
        },
      },
    });

    this.realtime.emitToOrg(organizationId, 'card:moved', {
      cardId,
      toStageId: saleStageId,
      status: CardStatus.WON,
    });
    this.logger.log(
      `Conversão: card ${cardId} → Venda (pedido ${order.orderId}, R$ ${order.total})`,
    );
  }
}
