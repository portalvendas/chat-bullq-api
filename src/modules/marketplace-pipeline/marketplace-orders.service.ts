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

  private static readonly SHOPEE_PAID_STATUS = new Set([
    'READY_TO_SHIP',
    'PROCESSED',
    'SHIPPED',
    'TO_CONFIRM_RECEIVE',
    'COMPLETED',
  ]);

  /**
   * Shopee: get_order_list (janela de 14 dias, máx da API é 15) → order_sn;
   * depois get_order_detail (lotes de 50) pedindo buyer_user_id/total_amount.
   * Indexa por `buyer_user_id` (== from_id do chat). Só conta pedidos "pagos"
   * (READY_TO_SHIP/PROCESSED/SHIPPED/TO_CONFIRM_RECEIVE/COMPLETED).
   *
   * NOTA: nomes de campo (buyer_user_id, total_amount, order_status) e os
   * status válidos precisam ser confirmados no sandbox com uma loja conectada.
   */
  private async fetchShopee(
    channel: Channel,
  ): Promise<Map<string, MarketplaceOrder>> {
    const out = new Map<string, MarketplaceOrder>();
    const cfg = (channel.config ?? {}) as Record<string, any>;
    if (!cfg.shopId || !cfg.accessToken) {
      this.logger.debug(`Shopee canal ${channel.id} não conectado — sem pedidos`);
      return out;
    }

    const now = Math.floor(Date.now() / 1000);
    const from = now - 14 * 24 * 60 * 60;

    try {
      // 1) Coleta os order_sn da janela (paginado por cursor).
      const orderSns: string[] = [];
      let cursor = '';
      let guard = 0;
      do {
        const res = await this.shopeeHttp.get(
          channel,
          '/api/v2/order/get_order_list',
          {
            time_range_field: 'create_time',
            time_from: from,
            time_to: now,
            page_size: 100,
            cursor,
          },
        );
        const r = res?.response ?? {};
        for (const o of Array.isArray(r.order_list) ? r.order_list : []) {
          if (o?.order_sn) orderSns.push(String(o.order_sn));
        }
        cursor = r.next_cursor ?? '';
        if (!r.more || !cursor) break;
      } while (++guard < 20 && orderSns.length < 500);

      // 2) Detalhe em lotes de 50 pra pegar comprador + valor.
      for (let i = 0; i < orderSns.length; i += 50) {
        const batch = orderSns.slice(i, i + 50);
        const res = await this.shopeeHttp.get(
          channel,
          '/api/v2/order/get_order_detail',
          {
            order_sn_list: batch.join(','),
            response_optional_fields:
              'buyer_user_id,buyer_username,total_amount,order_status',
          },
        );
        const list = res?.response?.order_list;
        for (const o of Array.isArray(list) ? list : []) {
          const buyerId = o?.buyer_user_id != null ? String(o.buyer_user_id) : '';
          if (!buyerId) continue;
          if (
            o?.order_status &&
            !MarketplaceOrdersService.SHOPEE_PAID_STATUS.has(o.order_status)
          ) {
            continue;
          }
          if (out.has(buyerId)) continue; // mantém o mais recente (ordem da API)
          out.set(buyerId, {
            orderId: String(o.order_sn),
            buyerId,
            buyerNickname: o.buyer_username,
            total: Number(o.total_amount ?? 0),
            currency: 'BRL',
            dateCreated: o.create_time
              ? new Date(Number(o.create_time) * 1000).toISOString()
              : undefined,
          });
        }
      }
      this.logger.log(
        `Shopee canal ${channel.id}: ${out.size} compradores com pedido pago`,
      );
    } catch (err: any) {
      this.logger.error(
        `Falha ao buscar pedidos Shopee (canal ${channel.id}): ${err?.message ?? err}`,
      );
    }
    return out;
  }
}
