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
  /** Bullets "O que você precisa saber sobre este produto" (main_features do ML). */
  highlights?: string[];
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
   * Perfil PÚBLICO do comprador (GET /users/{id}). Antes da venda o ML só
   * libera dado público: nickname, cidade/estado (nível), país, reputação e
   * link do perfil. Nome/e-mail/telefone/CPF NÃO vêm aqui (privados). Best-
   * effort: qualquer falha vira null (enriquecimento nunca quebra o fluxo).
   */
  async getBuyerProfile(
    channel: { id: string } & Record<string, any>,
    buyerId: string,
  ): Promise<{
    nickname?: string;
    city?: string;
    state?: string;
    country?: string;
    permalink?: string;
    registrationDate?: string;
  } | null> {
    if (!buyerId) return null;
    try {
      const u = await this.http.get(channel as any, `/users/${buyerId}`);
      if (!u?.id) return null;
      return {
        nickname: u?.nickname ?? undefined,
        city: u?.address?.city ?? undefined,
        state: u?.address?.state ?? undefined,
        country: u?.country_id ?? undefined,
        permalink: u?.permalink ?? undefined,
        registrationDate: u?.registration_date ?? undefined,
      };
    } catch (err: any) {
      this.logger.warn(
        `getBuyerProfile ${buyerId} falhou: ${err?.message ?? err}`,
      );
      return null;
    }
  }

  /**
   * Dados PESSOAIS do comprador liberados por causa da VENDA. Fonte primária é
   * o SHIPMENT (nome do destinatário + endereço de entrega); o billing_info
   * complementa o documento (CPF/CNPJ). Tudo best-effort e isolado em try/catch
   * — cada pedaço que faltar simplesmente não é preenchido.
   *
   * NOTA: `billing_info` no ML novo pode exigir o header `x-format-new: true`;
   * o http-client atual não envia headers custom, então tratamos como opcional.
   * O nome/endereço via shipment já é o dado mais confiável pós-venda.
   */
  async getOrderBuyerDetails(
    channel: { id: string } & Record<string, any>,
    orderId: string,
  ): Promise<{
    name?: string;
    doc?: string;
    address?: {
      line?: string;
      zipCode?: string;
      city?: string;
      state?: string;
    };
  } | null> {
    if (!orderId) return null;
    const out: {
      name?: string;
      doc?: string;
      address?: {
        line?: string;
        zipCode?: string;
        city?: string;
        state?: string;
      };
    } = {};

    // 1) Shipment → nome do destinatário + endereço.
    try {
      const order = await this.http.get(channel as any, `/orders/${orderId}`);
      const shipmentId = order?.shipping?.id;
      if (shipmentId) {
        const s = await this.http.get(
          channel as any,
          `/shipments/${shipmentId}`,
        );
        const r = s?.receiver_address;
        if (r) {
          out.name = r?.receiver_name ?? out.name;
          out.address = {
            line: r?.address_line ?? undefined,
            zipCode: r?.zip_code ?? undefined,
            city: r?.city?.name ?? undefined,
            state: r?.state?.name ?? undefined,
          };
        }
      }
    } catch (err: any) {
      this.logger.warn(
        `Shipment do pedido ${orderId} indisponível: ${err?.message ?? err}`,
      );
    }

    // 2) billing_info → documento (best-effort).
    try {
      const b = await this.http.get(
        channel as any,
        `/orders/${orderId}/billing_info`,
      );
      const info = b?.buyer?.billing_info ?? b?.billing_info ?? b;
      const first = info?.first_name ?? info?.name;
      const last = info?.last_name ?? '';
      const fullName = [first, last].filter(Boolean).join(' ').trim();
      if (!out.name && fullName) out.name = fullName;
      out.doc =
        info?.doc_number ??
        info?.identification?.number ??
        info?.document_number ??
        undefined;
    } catch {
      // billing_info costuma exigir header novo/escopo extra — ignorar.
    }

    return out.name || out.doc || out.address ? out : null;
  }

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

    // NÃO filtrar mlAnswered no Prisma: com JSON path, quando a chave não
    // existe a comparação vira NULL e `NOT ... = true` DESCARTA a linha —
    // justamente as perguntas ainda sem marca (o caso comum). Fetch amplo e
    // filtra no código (mesmo padrão do backfill/outbound).
    const cap = Math.min(Math.max(limit, 1), 500);
    const rows = await this.prisma.message.findMany({
      where: {
        direction: MessageDirection.INBOUND,
        type: MessageContentType.TEXT,
        conversation: { channelId: channel.id },
        externalId: { not: null },
      },
      select: {
        id: true,
        externalId: true,
        conversationId: true,
        metadata: true,
      },
      orderBy: { createdAt: 'desc' },
      take: 1000,
    });
    const open = rows
      .filter((m) => !(m.metadata as Record<string, unknown> | null)?.['mlAnswered'])
      .slice(0, cap);

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

  // ─── Diretório largura→anúncio (fonte de dados da loja) ──────────

  private static readonly NOTE_CATEGORY = '__nota__';

  /** Parseia o .txt "Links dos Organizadores" em linhas estruturadas.
   *  Formato: cabeçalho de categoria, depois pares "codigo | largura" + URL.
   *  Categorias são detectadas dinamicamente (qualquer linha que não seja
   *  par nem URL nem vazia); a "nota de altura" é capturada à parte. */
  parseDirectory(text: string): {
    rows: { categoria: string; larguraCm: number; codigo: string; mlb: string; url: string }[];
    note: string | null;
  } {
    const rows: { categoria: string; larguraCm: number; codigo: string; mlb: string; url: string }[] = [];
    let categoria: string | null = null;
    let pend: { codigo: string; larguraCm: number } | null = null;
    let note: string | null = null;
    for (const raw of (text ?? '').split(/\r?\n/)) {
      const s = raw.trim();
      if (!s) continue;
      const pair = s.match(/^(\d+)\s*\|\s*(\d+)\s*$/);
      if (pair) {
        pend = { codigo: pair[1], larguraCm: parseInt(pair[2], 10) };
        continue;
      }
      const url = s.match(/(MLB-?\d+)/i);
      if (url && /https?:\/\//i.test(s)) {
        if (pend && categoria) {
          rows.push({
            categoria,
            larguraCm: pend.larguraCm,
            codigo: pend.codigo,
            mlb: url[1].toUpperCase().replace('-', ''),
            url: s,
          });
        }
        pend = null;
        continue;
      }
      // Linha de texto: nota de altura ou cabeçalho de categoria.
      if (/altura/i.test(s) && /cm|%/i.test(s)) {
        note = s;
      } else {
        categoria = s;
        pend = null;
      }
    }
    return { rows, note };
  }

  /** Substitui por completo o diretório da org (reimportável). Aceita linhas
   *  já parseadas OU o texto cru do arquivo. */
  async importDirectory(
    organizationId: string,
    input: {
      rows?: { categoria: string; larguraCm: number; codigo?: string; mlb: string; url: string }[];
      text?: string;
    },
  ): Promise<{ imported: number; categorias: number; note: string | null }> {
    let rows = input.rows;
    let note: string | null = null;
    if ((!rows || rows.length === 0) && input.text) {
      const parsed = this.parseDirectory(input.text);
      rows = parsed.rows;
      note = parsed.note;
    }
    if (!rows || rows.length === 0) {
      throw new BadGatewayException('Nenhuma linha válida no diretório enviado');
    }

    const data = rows
      .filter((r) => r?.categoria && r?.larguraCm && r?.mlb && r?.url)
      .map((r) => ({
        organizationId,
        categoria: String(r.categoria).trim(),
        larguraCm: Number(r.larguraCm),
        codigo: r.codigo ? String(r.codigo) : null,
        mlb: String(r.mlb).toUpperCase().replace('-', ''),
        url: String(r.url).trim(),
      }));

    // Nota de altura vira uma linha especial (categoria __nota__) pra ficar
    // no mesmo diretório reimportável.
    if (note) {
      data.push({
        organizationId,
        categoria: MercadoLivreProductsService.NOTE_CATEGORY,
        larguraCm: 0,
        codigo: null,
        mlb: '-',
        url: note,
      });
    }

    await this.prisma.$transaction([
      this.prisma.mlProductDirectory.deleteMany({ where: { organizationId } }),
      this.prisma.mlProductDirectory.createMany({ data, skipDuplicates: true }),
    ]);

    const categorias = new Set(
      data
        .filter((d) => d.categoria !== MercadoLivreProductsService.NOTE_CATEGORY)
        .map((d) => d.categoria),
    ).size;
    return { imported: data.length, categorias, note };
  }

  /** Lista o diretório atual da org, agrupado por categoria (pra tela de
   *  gestão no BullQ). Separa a nota de altura. */
  async listDirectory(organizationId: string): Promise<{
    total: number;
    note: string | null;
    categorias: {
      categoria: string;
      itens: { larguraCm: number; mlb: string; url: string }[];
    }[];
  }> {
    const all = await this.prisma.mlProductDirectory.findMany({
      where: { organizationId },
      orderBy: [{ categoria: 'asc' }, { larguraCm: 'asc' }],
    });
    const noteRow = all.find(
      (r) => r.categoria === MercadoLivreProductsService.NOTE_CATEGORY,
    );
    const rows = all.filter(
      (r) => r.categoria !== MercadoLivreProductsService.NOTE_CATEGORY,
    );
    const byCat = new Map<
      string,
      { larguraCm: number; mlb: string; url: string }[]
    >();
    for (const r of rows) {
      const arr = byCat.get(r.categoria) ?? [];
      arr.push({ larguraCm: r.larguraCm, mlb: r.mlb, url: r.url });
      byCat.set(r.categoria, arr);
    }
    return {
      total: rows.length,
      note: noteRow?.url ?? null,
      categorias: [...byCat.entries()].map(([categoria, itens]) => ({
        categoria,
        itens,
      })),
    };
  }

  /** Dado uma largura de gaveta (cm) e, opcionalmente, uma categoria, devolve
   *  o(s) anúncio(s) sob medida corretos — a menor faixa que atende a largura
   *  (arredonda pra cima). Sem categoria = uma opção por categoria. */
  async findOrganizer(
    organizationId: string,
    larguraCm: number,
    categoria?: string,
  ): Promise<{
    larguraSolicitada: number;
    categoriaFiltro: string | null;
    opcoes: { categoria: string; larguraCm: number; mlb: string; url: string }[];
    observacao: string | null;
  }> {
    const all = await this.prisma.mlProductDirectory.findMany({
      where: { organizationId },
    });
    const noteRow = all.find(
      (r) => r.categoria === MercadoLivreProductsService.NOTE_CATEGORY,
    );
    let rows = all.filter(
      (r) => r.categoria !== MercadoLivreProductsService.NOTE_CATEGORY,
    );

    const norm = (s: string) =>
      s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (categoria && categoria.trim()) {
      const c = norm(categoria);
      const filtered = rows.filter(
        (r) => norm(r.categoria).includes(c) || c.includes(norm(r.categoria)),
      );
      if (filtered.length) rows = filtered;
    }

    const w = Number(larguraCm) || 0;
    const byCat = new Map<string, typeof rows>();
    for (const r of rows) {
      const arr = byCat.get(r.categoria) ?? [];
      arr.push(r);
      byCat.set(r.categoria, arr);
    }
    const opcoes: { categoria: string; larguraCm: number; mlb: string; url: string }[] = [];
    for (const [cat, rs] of byCat.entries()) {
      const sorted = rs.sort((a, b) => a.larguraCm - b.larguraCm);
      const band = sorted.find((r) => r.larguraCm >= w) ?? sorted[sorted.length - 1];
      if (band) {
        opcoes.push({
          categoria: cat,
          larguraCm: band.larguraCm,
          mlb: band.mlb,
          url: band.url,
        });
      }
    }
    return {
      larguraSolicitada: w,
      categoriaFiltro: categoria?.trim() || null,
      opcoes,
      observacao: noteRow?.url ?? null,
    };
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
        'id,title,price,currency_id,available_quantity,permalink,thumbnail,status,attributes,main_features';
      const item = await this.http.get(channel, `/items/${itemId}?attributes=${attrs}`);
      const product = this.normalize(item);

      // Destaques "O que você precisa saber sobre este produto" (main_features).
      // Prosa gerada pelo ML com specs em linguagem natural (ex: "suporte para
      // televisores de até 43 polegadas"). Complementa os atributos crus.
      const mf = Array.isArray(item.main_features) ? item.main_features : [];
      const highlights = mf
        .map((f: any) => String(f?.text ?? '').trim())
        .filter((t: string) => t.length > 0)
        .slice(0, 20);
      if (highlights.length) product.highlights = highlights;

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
