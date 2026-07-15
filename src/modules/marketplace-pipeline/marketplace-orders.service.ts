import { Injectable, Logger } from '@nestjs/common';
import { Channel, ChannelType } from '@prisma/client';
import { MercadoLivreHttpClient } from '../channel-hub/adapters/mercado-livre/mercadolivre.http-client';
import { ShopeeHttpClient } from '../channel-hub/adapters/shopee/shopee.http-client';

/** Pedido pago normalizado, indexado pelo comprador (buyer_id). */
export interface MarketplaceOrder {
  orderId: string;
  buyerId: string;
  buyerNickname?: string;
  total: number;
  currency: string;
  dateCreated?: string;
}

/**
 * Busca pedidos PAGOS recentes na API do canal e devolve um índice
 * `buyer_id → pedido` (mantendo o mais recente por comprador). É esse índice
 * que o MarketplaceConversionService cruza com o buyer_id de quem fez a
 * pergunta pra detectar a conversão.
 *
 * Falha de API de terceiro NÃO derruba o fluxo: logamos e devolvemos o que
 * conseguimos (mapa possivelmente vazio) — o cron tenta de novo no próximo ciclo.
 */
@Injectable()
export class MarketplaceOrdersService {
  private readonly logger = new Logger(MarketplaceOrdersService.name);
  private static readonly ML_ORDER_LIMIT = 50;

  constructor(
    private readonly mlHttp: MercadoLivreHttpClient,
    private readonly shopeeHttp: ShopeeHttpClient,
  ) {}

  async fetchPaidOrdersByBuyer(
    channel: Channel,
  ): Promise<Map<string, MarketplaceOrder>> {
    switch (channel.type) {
      case ChannelType.MERCADO_LIVRE:
        return this.fetchMercadoLivre(channel);
      case ChannelType.SHOPEE:
        return this.fetchShopee(channel);
      default:
        return new Map();
    }
  }

  /**
   * Mercado Livre: GET /orders/search?seller={sellerId}&order.status=paid.
   * Payload esperado: { results: [{ id, total_amount, currency_id,
   * date_created, buyer: { id, nickname } }] }. buyer.id casa exatamente com
   * o `from.id` da pergunta (mesmo id de usuário ML).
   */
  private async fetchMercadoLivre(
    channel: Channel,
  ): Promise<Map<string, MarketplaceOrder>> {
    const out = new Map<string, MarketplaceOrder>();
    const cfg = (channel.config ?? {}) as Record<string, any>;
    const sellerId = cfg.sellerId;
    if (!sellerId) {
      this.logger.warn(`Canal ML ${channel.id} sem sellerId — pulando pedidos`);
      return out;
    }
    try {
      const path =
        `/orders/search?seller=${encodeURIComponent(String(sellerId))}` +
        `&order.status=paid&sort=date_desc&limit=${MarketplaceOrdersService.ML_ORDER_LIMIT}`;
      const res = await this.mlHttp.get(channel, path);
      const results: any[] = Array.isArray(res?.results) ? res.results : [];
      for (const o of results) {
        const buyerId = o?.buyer?.id != null ? String(o.buyer.id) : '';
        if (!buyerId) continue;
        // results vem em date_desc → o primeiro por comprador é o mais recente.
        if (out.has(buyerId)) continue;
        out.set(buyerId, {
          orderId: String(o.id),
          buyerId,
          buyerNickname: o?.buyer?.nickname,
          total: Number(o.total_amount ?? 0),
          currency: String(o.currency_id ?? 'BRL'),
          dateCreated: o.date_created,
        });
      }
      this.logger.log(
        `ML canal ${channel.id}: ${out.size} compradores com pedido pago`,
      );
    } catch (err: any) {
      this.logger.error(
        `Falha ao buscar pedidos ML (canal ${channel.id}): ${err?.message ?? err}`,
      );
    }
    return out;
  }

  /**
   * Shopee: TODO — implementar via /api/v2/order/get_order_list (status
   * COMPLETED/READY_TO_SHIP) + /api/v2/order/get_order_detail p/ buyer_user_id
   * e total_amount. Sandbox não tem pedidos ainda, então por ora devolve vazio
   * (a estrutura de cruzamento já funciona; só falta a fonte de pedidos).
   */
  private async fetchShopee(
    channel: Channel,
  ): Promise<Map<string, MarketplaceOrder>> {
    // Mantém a assinatura pronta; validar campos no sandbox antes de ligar.
    void this.shopeeHttp;
    this.logger.debug(
      `Shopee canal ${channel.id}: busca de pedidos ainda não habilitada (Fase 2)`,
    );
    return new Map();
  }
}
