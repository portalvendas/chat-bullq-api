import {
  Injectable,
  Logger,
  NotFoundException,
  BadGatewayException,
} from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { MercadoLivreHttpClient } from './mercadolivre.http-client';

export interface MlProduct {
  id: string;
  title: string;
  price: number | null;
  currency: string | null;
  availableQuantity: number | null;
  status: string;
  permalink: string | null;
  thumbnail: string | null;
  attributes: { name: string; value: string }[];
  description?: string;
  qa?: { pergunta: string; resposta: string }[];
}

/**
 * Busca produtos ATIVOS do vendedor no Mercado Livre, reusando o token OAuth
 * já guardado no canal (renovado automaticamente). Usado pelo endpoint público
 * consumido pela Tool do Jarvis.
 */
@Injectable()
export class MercadoLivreProductsService {
  private readonly logger = new Logger(MercadoLivreProductsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: MercadoLivreHttpClient,
  ) {}

  async search(
    organizationId: string,
    q: string,
    limit = 10,
  ): Promise<{ query: string; total: number; products: MlProduct[] }> {
    const channel = await this.prisma.channel.findFirst({
      where: {
        organizationId,
        type: ChannelType.MERCADO_LIVRE,
        isActive: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!channel) {
      throw new NotFoundException(
        'Organização sem canal Mercado Livre conectado',
      );
    }
    const cfg = (channel.config ?? {}) as Record<string, any>;
    const sellerId = cfg.sellerId;
    if (!sellerId) {
      throw new NotFoundException(
        'Canal Mercado Livre não conectado (sem sellerId — refazer OAuth)',
      );
    }

    const capped = Math.min(Math.max(Number(limit) || 10, 1), 50);

    try {
      // 1) ids dos anúncios ATIVOS que casam com a busca
      const search = await this.http.get(
        channel,
        `/users/${sellerId}/items/search?status=active&q=${encodeURIComponent(
          q,
        )}&limit=${capped}`,
      );
      const ids: string[] = Array.isArray(search?.results) ? search.results : [];
      if (!ids.length) return { query: q, total: 0, products: [] };

      // 2) detalhes em lote (multiget devolve [{ code, body }])
      const attrs =
        'id,title,price,currency_id,available_quantity,permalink,thumbnail,status,attributes';
      const items = await this.http.get(
        channel,
        `/items?ids=${ids.join(',')}&attributes=${attrs}`,
      );
      const products: MlProduct[] = (Array.isArray(items) ? items : [])
        .filter((x: any) => x?.code === 200 && x?.body)
        .map((x: any) => this.normalize(x.body));

      return { query: q, total: products.length, products };
    } catch (error: any) {
      this.logger.error(
        `Busca de produtos ML falhou (org ${organizationId}, q="${q}"): ${
          error.response?.status || ''
        } ${error.message}`,
      );
      throw new BadGatewayException('Falha ao consultar o Mercado Livre');
    }
  }

  /**
   * Detalhe de UM anúncio: dados básicos + descrição longa (onde ficam as
   * tabelas de medida por modelo) + perguntas/respostas já respondidas no
   * próprio anúncio (base de conhecimento pro agente reaproveitar).
   */
  async getDetail(
    organizationId: string,
    itemId: string,
  ): Promise<MlProduct> {
    const channel = await this.prisma.channel.findFirst({
      where: { organizationId, type: ChannelType.MERCADO_LIVRE, isActive: true },
      orderBy: { createdAt: 'desc' },
    });
    if (!channel) {
      throw new NotFoundException('Organização sem canal Mercado Livre conectado');
    }
    try {
      const attrs =
        'id,title,price,currency_id,available_quantity,permalink,thumbnail,status,attributes';
      const item = await this.http.get(channel, `/items/${itemId}?attributes=${attrs}`);
      const product = this.normalize(item);

      // descrição longa (texto puro)
      try {
        const desc = await this.http.get(channel, `/items/${itemId}/description`);
        const text = desc?.plain_text || desc?.text;
        if (text) product.description = String(text).slice(0, 6000);
      } catch (e: any) {
        this.logger.warn(`Sem descrição para ${itemId}: ${e.message}`);
      }

      // perguntas já respondidas nesse anúncio (até 15 mais recentes)
      try {
        const qres = await this.http.get(
          channel,
          `/questions/search?item=${itemId}&api_version=4&sort_fields=date_created&sort_types=DESC&limit=30`,
        );
        const qs = Array.isArray(qres?.questions) ? qres.questions : [];
        product.qa = qs
          .filter((q: any) => q?.answer?.text)
          .slice(0, 15)
          .map((q: any) => ({
            pergunta: String(q.text || '').slice(0, 500),
            resposta: String(q.answer.text || '').slice(0, 500),
          }));
      } catch (e: any) {
        this.logger.warn(`Sem Q&A para ${itemId}: ${e.message}`);
      }

      return product;
    } catch (error: any) {
      this.logger.error(`Detalhe ML ${itemId} falhou: ${error.response?.status || ''} ${error.message}`);
      throw new BadGatewayException('Falha ao consultar o Mercado Livre');
    }
  }

  private normalize(item: any): MlProduct {
    return {
      id: item.id,
      title: item.title,
      price: item.price ?? null,
      currency: item.currency_id ?? null,
      availableQuantity: item.available_quantity ?? null,
      status: item.status,
      permalink: item.permalink ?? null,
      thumbnail: item.thumbnail ?? null,
      attributes: (Array.isArray(item.attributes) ? item.attributes : [])
        .filter((a: any) => a?.value_name)
        .map((a: any) => ({ name: a.name, value: a.value_name })),
    };
  }
}
