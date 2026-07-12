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
