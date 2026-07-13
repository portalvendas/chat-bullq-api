import {
  Injectable,
  Logger,
  NotFoundException,
  BadGatewayException,
} from '@nestjs/common';
import {
  ChannelType,
  MessageDirection,
  MessageContentType,
  MessageStatus,
} from '@prisma/client';
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

  /**
   * BACKFILL (idempotente): re-enriquece perguntas ML antigas que entraram
   * antes do enriquecimento de anúncio. Para cada mensagem INBOUND sem
   * `content.mlItem`, pega o `item_id` do payload cru já salvo
   * (`metadata.rawPayload.item_id`), busca o anúncio em lote e grava
   * `content.mlItem` + o bloco "Sobre o anúncio" no texto (se ainda não tiver).
   * Seguro rodar várias vezes: só toca no que falta.
   */
  async backfillMessageItems(
    organizationId: string,
    channelId?: string,
  ): Promise<{ scanned: number; candidates: number; updated: number }> {
    const channel = await this.prisma.channel.findFirst({
      where: {
        ...(channelId ? { id: channelId } : {}),
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

    const messages = await this.prisma.message.findMany({
      where: {
        direction: MessageDirection.INBOUND,
        type: MessageContentType.TEXT,
        conversation: { channelId: channel.id },
      },
      select: { id: true, content: true, metadata: true },
    });

    // Candidatas: sem mlItem e com item_id no payload cru.
    const candidates = messages
      .map((m) => {
        const content = (m.content ?? {}) as Record<string, any>;
        if (content?.mlItem) return null;
        const raw = ((m.metadata as any)?.rawPayload ?? {}) as Record<
          string,
          any
        >;
        const itemId = raw?.item_id ? String(raw.item_id) : null;
        if (!itemId) return null;
        return { id: m.id, content, itemId };
      })
      .filter(Boolean) as { id: string; content: any; itemId: string }[];

    if (candidates.length === 0) {
      return { scanned: messages.length, candidates: 0, updated: 0 };
    }

    // Busca os anúncios em lote (multiget, dedup, páginas de 20).
    const uniqueIds = [...new Set(candidates.map((c) => c.itemId))];
    const itemMap = new Map<
      string,
      { title: string; permalink: string; thumbnail: string | null }
    >();
    for (let i = 0; i < uniqueIds.length; i += 20) {
      const batch = uniqueIds.slice(i, i + 20);
      try {
        const res = await this.http.get(
          channel,
          `/items?ids=${batch.join(',')}&attributes=id,title,permalink,thumbnail`,
        );
        for (const x of Array.isArray(res) ? res : []) {
          if (x?.code === 200 && x?.body?.id) {
            itemMap.set(String(x.body.id), {
              title: x.body.title ?? String(x.body.id),
              permalink: x.body.permalink ?? '',
              thumbnail: x.body.thumbnail ?? null,
            });
          }
        }
      } catch (err: any) {
        this.logger.warn(
          `Backfill: falha ao buscar itens [${batch.join(',')}]: ${err?.message ?? err}`,
        );
      }
    }

    let updated = 0;
    for (const c of candidates) {
      const item = itemMap.get(c.itemId);
      if (!item) continue;
      const text = typeof c.content.text === 'string' ? c.content.text : '';
      const hasContext = text.includes('Sobre o anúncio desta pergunta');
      const newContent = {
        ...c.content,
        mlItem: {
          id: c.itemId,
          title: item.title,
          permalink: item.permalink,
          thumbnail: item.thumbnail,
        },
        text: hasContext
          ? text
          : `${text}\n\n── Sobre o anúncio desta pergunta ──\n${item.title}\nID: ${c.itemId}` +
            (item.permalink ? `\n${item.permalink}` : ''),
      };
      await this.prisma.message.update({
        where: { id: c.id },
        data: { content: newContent },
      });
      updated++;
    }

    this.logger.log(
      `Backfill ML: scanned=${messages.length} candidates=${candidates.length} updated=${updated} (canal ${channel.id})`,
    );
    return { scanned: messages.length, candidates: candidates.length, updated };
  }

  /**
   * RECONCILIAÇÃO: mantém as perguntas atualizadas quando são respondidas por
   * FORA (ex: vendedor respondeu direto no painel do ML). Varre as perguntas
   * (inbound) ainda NÃO marcadas como respondidas por nós, consulta cada uma
   * no ML e, se estiver `ANSWERED`, marca como respondida aqui e importa a
   * resposta como uma mensagem OUTBOUND (pra o operador ver o que foi dito).
   *
   * Como só olhamos perguntas não-respondidas por nós, qualquer resposta
   * encontrada veio de outro canal → seguro importar. Idempotente
   * (dedup por externalId `mla-ext-{qid}`).
   */
  async reconcileAnswers(
    organizationId: string,
    channelId?: string,
    limit = 200,
  ): Promise<{
    scanned: number;
    checked: number;
    markedAnswered: number;
    imported: number;
  }> {
    const channel = await this.prisma.channel.findFirst({
      where: {
        ...(channelId ? { id: channelId } : {}),
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

    const open = await this.prisma.message.findMany({
      where: {
        direction: MessageDirection.INBOUND,
        type: MessageContentType.TEXT,
        conversation: { channelId: channel.id },
        externalId: { not: null },
        NOT: { metadata: { path: ['mlAnswered'], equals: true } },
      },
      select: {
        id: true,
        externalId: true,
        conversationId: true,
        metadata: true,
      },
      take: Math.min(Math.max(limit, 1), 500),
    });

    let checked = 0;
    let markedAnswered = 0;
    let imported = 0;

    for (const m of open) {
      const qid = String(m.externalId);
      let q: any;
      try {
        q = await this.http.get(channel, `/questions/${qid}?api_version=4`);
      } catch (err: any) {
        this.logger.warn(
          `Reconcile: falha ao consultar question ${qid}: ${err?.message ?? err}`,
        );
        continue;
      }
      checked++;

      const status = q?.status;
      const answerText: string | undefined = q?.answer?.text;
      const isAnswered = status === 'ANSWERED' || !!answerText;
      if (!isAnswered) continue;

      await this.prisma.message.update({
        where: { id: m.id },
        data: {
          metadata: {
            ...((m.metadata as Record<string, unknown> | null) ?? {}),
            mlAnswered: true,
            mlAnsweredAt: new Date().toISOString(),
            mlAnsweredExternally: true,
          },
        },
      });
      markedAnswered++;

      // Importa a resposta externa como OUTBOUND (dedup por externalId).
      if (answerText) {
        try {
          await this.prisma.message.create({
            data: {
              conversationId: m.conversationId,
              direction: MessageDirection.OUTBOUND,
              type: MessageContentType.TEXT,
              content: { text: answerText },
              status: MessageStatus.SENT,
              senderName: 'Mercado Livre (resposta externa)',
              externalId: `mla-ext-${qid}`,
              sentAt: q?.answer?.date_created
                ? new Date(q.answer.date_created)
                : new Date(),
              metadata: { mlExternalAnswer: true, questionId: qid },
            },
          });
          imported++;
        } catch (err: any) {
          // P2002 = já importada num run anterior (idempotente).
          if (err?.code !== 'P2002') {
            this.logger.warn(
              `Reconcile: falha ao importar resposta da question ${qid}: ${err?.message ?? err}`,
            );
          }
        }
      }
    }

    this.logger.log(
      `Reconcile ML: scanned=${open.length} checked=${checked} marked=${markedAnswered} imported=${imported} (canal ${channel.id})`,
    );
    return { scanned: open.length, checked, markedAnswered, imported };
  }

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
