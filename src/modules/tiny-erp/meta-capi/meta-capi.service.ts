import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { MetaCapiHttpClient, CapiEvent } from './meta-capi.http-client';
import {
  hashEmail,
  hashPhone,
  hashName,
  hashCity,
  hashState,
  hashZip,
  hashCountry,
  hashExternalId,
  splitName,
  fbcFromFbclid,
} from './meta-capi.hash';
import { phoneVariants } from '../../../common/phone.util';

export interface MetaCapiConfigInput {
  enabled?: boolean;
  pixelId?: string | null;
  accessToken?: string | null;
  apiVersion?: string;
  testEventCode?: string | null;
  currency?: string;
  purchaseSituacoes?: string[];
  addToCartEnabled?: boolean;
  addToCartSituacoes?: string[];
}

/** Doc mínimo que o CAPI precisa (subset da TinyDocument). */
interface DocForCapi {
  id: string;
  kind: string;
  situacao: string | null;
  numero: string | null;
  data: Date | null;
  valor: any; // Decimal | number | null
  clienteNome: string | null;
  clienteCpfCnpj: string | null;
  clienteTelefone: string | null;
  clienteEmail: string | null;
  contactId: string | null;
  raw: any;
}

// Eventos website (dataset do Pixel) só são aceitos dentro de ~7 dias.
const EVENT_WINDOW_MS = 7 * 24 * 3600 * 1000;

@Injectable()
export class MetaCapiService {
  private readonly logger = new Logger(MetaCapiService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: MetaCapiHttpClient,
  ) {}

  // ── Config ──────────────────────────────────────────────────────────

  /** Config da org com o token MASCARADO (nunca expõe o token no read). */
  async getConfig(organizationId: string) {
    const c = await this.prisma.metaCapiConfig.findUnique({
      where: { organizationId },
    });
    if (!c) {
      return {
        enabled: false,
        pixelId: null,
        apiVersion: 'v21.0',
        testEventCode: null,
        currency: 'BRL',
        purchaseSituacoes: ['Faturada', 'Aprovada'],
        addToCartEnabled: true,
        addToCartSituacoes: [] as string[],
        hasToken: false,
        lastError: null,
      };
    }
    return {
      enabled: c.enabled,
      pixelId: c.pixelId,
      apiVersion: c.apiVersion,
      testEventCode: c.testEventCode,
      currency: c.currency,
      purchaseSituacoes: (c.purchaseSituacoes as string[]) ?? [],
      addToCartEnabled: c.addToCartEnabled,
      addToCartSituacoes: (c.addToCartSituacoes as string[]) ?? [],
      hasToken: !!c.accessToken,
      lastError: c.lastError,
    };
  }

  async updateConfig(organizationId: string, dto: MetaCapiConfigInput) {
    // Token só é alterado quando vem preenchido (não apaga ao salvar em branco).
    const tokenPatch =
      typeof dto.accessToken === 'string' && dto.accessToken.trim()
        ? { accessToken: dto.accessToken.trim() }
        : {};
    const data: any = {
      ...(dto.enabled !== undefined ? { enabled: dto.enabled } : {}),
      ...(dto.pixelId !== undefined ? { pixelId: dto.pixelId } : {}),
      ...(dto.apiVersion !== undefined ? { apiVersion: dto.apiVersion } : {}),
      ...(dto.testEventCode !== undefined ? { testEventCode: dto.testEventCode } : {}),
      ...(dto.currency !== undefined ? { currency: dto.currency } : {}),
      ...(dto.purchaseSituacoes !== undefined
        ? { purchaseSituacoes: dto.purchaseSituacoes as any }
        : {}),
      ...(dto.addToCartEnabled !== undefined
        ? { addToCartEnabled: dto.addToCartEnabled }
        : {}),
      ...(dto.addToCartSituacoes !== undefined
        ? { addToCartSituacoes: dto.addToCartSituacoes as any }
        : {}),
      ...tokenPatch,
    };
    await this.prisma.metaCapiConfig.upsert({
      where: { organizationId },
      create: { organizationId, ...data },
      update: data,
    });
    return this.getConfig(organizationId);
  }

  // ── Emissão ─────────────────────────────────────────────────────────

  /**
   * Avalia um documento do Tiny e, se casar com a config, envia o evento CAPI
   * correspondente (Purchase/AddToCart). Idempotente (1 por doc+evento) e
   * best-effort. Chamado pelo sync do Tiny após o upsert.
   *
   * `configCache` evita reler a config a cada documento numa rodada de sync.
   */
  async maybeEmit(
    organizationId: string,
    doc: DocForCapi,
    configCache?: Awaited<ReturnType<MetaCapiService['loadRawConfig']>> | null,
  ): Promise<void> {
    const cfg = configCache ?? (await this.loadRawConfig(organizationId));
    if (!cfg || !cfg.enabled || !cfg.pixelId || !cfg.accessToken) return;

    const eventName = this.resolveEvent(cfg, doc);
    if (!eventName) return;

    // Janela de 7 dias da Meta (dataset do Pixel). Fora dela, não envia.
    const when = doc.data ? doc.data.getTime() : Date.now();
    if (Date.now() - when > EVENT_WINDOW_MS) return;

    // Conversão sem valor válido (> 0) NÃO é enviada: a Meta trata value/currency
    // ausente ou zerado como "moeda de baixa qualidade". Sai sem registrar, pra
    // retentar numa próxima rodada quando o valor estiver disponível — nunca 0.
    const valGuard = this.num(doc.valor);
    if (!(typeof valGuard === 'number' && Number.isFinite(valGuard) && valGuard > 0)) {
      this.logger.warn(
        `CAPI ${eventName} pulado sem valor válido doc=${doc.numero ?? doc.id}`,
      );
      return;
    }

    // Idempotência: se já foi enviado com sucesso, não repete.
    const existing = await this.prisma.metaCapiEvent.findUnique({
      where: { uq_capi_doc_event: { tinyDocumentId: doc.id, eventName } },
    });
    if (existing?.status === 'sent') return;

    try {
      const event = await this.buildEvent(organizationId, doc, eventName, cfg.currency);
      const result = await this.http.sendEvents({
        pixelId: cfg.pixelId,
        accessToken: cfg.accessToken,
        apiVersion: cfg.apiVersion,
        events: [event],
        testEventCode: cfg.testEventCode,
      });
      await this.prisma.metaCapiEvent.upsert({
        where: { uq_capi_doc_event: { tinyDocumentId: doc.id, eventName } },
        create: {
          organizationId,
          tinyDocumentId: doc.id,
          eventName,
          status: result.ok ? 'sent' : 'failed',
          httpStatus: result.httpStatus,
          fbTraceId: result.fbTraceId ?? null,
          error: result.ok ? null : result.error ?? null,
          value: this.num(doc.valor),
          eventId: event.event_id ?? null,
        },
        update: {
          status: result.ok ? 'sent' : 'failed',
          httpStatus: result.httpStatus,
          fbTraceId: result.fbTraceId ?? null,
          error: result.ok ? null : result.error ?? null,
          sentAt: new Date(),
        },
      });
      if (result.ok) {
        this.logger.log(
          `CAPI ${eventName} enviado doc=${doc.numero ?? doc.id} trace=${result.fbTraceId ?? '-'}`,
        );
      }
    } catch (err: any) {
      this.logger.warn(`CAPI maybeEmit falhou doc=${doc.id}: ${err?.message ?? err}`);
    }
  }

  /**
   * Varre os documentos recém-sincronizados que casam com a config e ainda não
   * tiveram o evento enviado, e emite (capado por rodada). Chamado pelo sync do
   * Tiny. No-op quando a integração está desligada.
   */
  async emitPending(organizationId: string, limit = 200): Promise<void> {
    const cfg = await this.loadRawConfig(organizationId);
    if (!cfg?.enabled || !cfg.pixelId || !cfg.accessToken) return;

    const since = new Date(Date.now() - EVENT_WINDOW_MS);
    const select = {
      id: true,
      kind: true,
      situacao: true,
      numero: true,
      data: true,
      valor: true,
      clienteNome: true,
      clienteCpfCnpj: true,
      clienteTelefone: true,
      clienteEmail: true,
      contactId: true,
      raw: true,
    } as const;

    const pedidos = cfg.purchaseSituacoes.length
      ? await this.prisma.tinyDocument.findMany({
          where: {
            organizationId,
            kind: 'PEDIDO',
            data: { gte: since },
            situacao: { in: cfg.purchaseSituacoes },
            capiEvents: { none: { eventName: 'Purchase', status: 'sent' } },
          },
          select,
          take: limit,
        })
      : [];
    for (const d of pedidos) await this.maybeEmit(organizationId, d as any, cfg);

    if (cfg.addToCartEnabled) {
      const orcamentos = await this.prisma.tinyDocument.findMany({
        where: {
          organizationId,
          kind: 'ORCAMENTO',
          data: { gte: since },
          ...(cfg.addToCartSituacoes.length
            ? { situacao: { in: cfg.addToCartSituacoes } }
            : {}),
          capiEvents: { none: { eventName: 'AddToCart', status: 'sent' } },
        },
        select,
        take: limit,
      });
      for (const d of orcamentos) await this.maybeEmit(organizationId, d as any, cfg);
    }
  }

  /** Config crua (com token) — uso interno no sync. */
  async loadRawConfig(organizationId: string) {
    const c = await this.prisma.metaCapiConfig.findUnique({
      where: { organizationId },
    });
    if (!c) return null;
    return {
      enabled: c.enabled,
      pixelId: c.pixelId,
      accessToken: c.accessToken,
      apiVersion: c.apiVersion || 'v21.0',
      testEventCode: c.testEventCode,
      currency: c.currency || 'BRL',
      purchaseSituacoes: (c.purchaseSituacoes as string[]) ?? [],
      addToCartEnabled: c.addToCartEnabled,
      addToCartSituacoes: (c.addToCartSituacoes as string[]) ?? [],
    };
  }

  private resolveEvent(
    cfg: NonNullable<Awaited<ReturnType<MetaCapiService['loadRawConfig']>>>,
    doc: DocForCapi,
  ): 'Purchase' | 'AddToCart' | null {
    const sit = (doc.situacao ?? '').trim();
    if (doc.kind === 'PEDIDO') {
      return cfg.purchaseSituacoes.some((s) => s.trim().toLowerCase() === sit.toLowerCase())
        ? 'Purchase'
        : null;
    }
    if (doc.kind === 'ORCAMENTO' && cfg.addToCartEnabled) {
      const list = cfg.addToCartSituacoes;
      if (!list.length) return 'AddToCart';
      return list.some((s) => s.trim().toLowerCase() === sit.toLowerCase())
        ? 'AddToCart'
        : null;
    }
    return null;
  }

  private async buildEvent(
    organizationId: string,
    doc: DocForCapi,
    eventName: 'Purchase' | 'AddToCart',
    currency: string,
  ): Promise<CapiEvent> {
    // Endereço do cliente (do detalhe do pedido, quando presente no raw).
    const cli = (doc.raw?.cliente ?? {}) as Record<string, any>;
    const end = (cli.endereco ??
      (Array.isArray(cli.enderecos) ? cli.enderecos[0] : undefined) ??
      {}) as Record<string, any>;
    const tsMs = doc.data ? doc.data.getTime() : Date.now();

    // Enriquecimento com o lead do CRM. O Purchase/AddToCart nasce do Tiny
    // (CPF/nome/endereco fortes, porem telefone/e-mail esparsos e SEM fbclid).
    // O contato do CRM tem o telefone bom (E.164), e-mail e o tracking da LP
    // (fbp/fbc/fbclid). Casamos a venda ao contato (contact_id do sync; senao
    // CPF->telefone->e-mail->nome ao vivo) e PREFERIMOS os dados do CRM sobre os
    // do Tiny — e isso que sobe o match quality do telefone e destrava o fbc.
    const crm = await this.resolveContactForDoc(organizationId, doc);
    const tr = (crm?.tracking ?? {}) as Record<string, any>;

    const phone = crm?.phone || doc.clienteTelefone;
    const email = crm?.email || doc.clienteEmail;
    const { first, last } = splitName(crm?.name || doc.clienteNome);

    // fbc: usa o cookie real (_fbc) quando existir; senao reconstroi
    // fb.1.<ts>.<fbclid> com o instante do LEAD (createdAt do contato ~ clique),
    // nao a data da venda — timestamp errado degrada o casamento na Meta.
    const leadTs = crm?.createdAt ? crm.createdAt.getTime() : tsMs;
    const fbc = tr.fbc || fbcFromFbclid(tr.fbclid, leadTs);

    const user_data: Record<string, any> = {
      em: arr(hashEmail(email)),
      ph: arr(hashPhone(phone)),
      fn: arr(hashName(first)),
      ln: arr(hashName(last)),
      ct: arr(hashCity(end.municipio ?? end.cidade)),
      st: arr(hashState(end.uf ?? end.estado)),
      zp: arr(hashZip(end.cep)),
      country: arr(hashCountry(end.pais)),
      external_id: arr(hashExternalId(doc.clienteCpfCnpj)),
      fbc: fbc || undefined,
      fbp: tr.fbp || undefined,
      client_ip_address: tr.client_ip_address || tr.client_ip || tr.ip || undefined,
      client_user_agent: tr.client_user_agent || tr.user_agent || undefined,
    };
    // Remove chaves vazias.
    for (const k of Object.keys(user_data)) {
      if (user_data[k] == null) delete user_data[k];
    }

    // Itens (SKU/qtd) do raw quando existirem.
    const itens: any[] = Array.isArray(doc.raw?.itens) ? doc.raw.itens : [];
    const contents = itens
      .map((it) => ({
        id: it?.produto?.sku ?? it?.produto?.id ?? it?.codigo,
        quantity: Number(it?.quantidade ?? 1),
      }))
      .filter((c) => c.id != null);

    // currency SEMPRE presente e válido (evita "moeda de baixa qualidade").
    const cur = (currency || 'BRL').toString().trim().toUpperCase() || 'BRL';
    const custom_data: Record<string, any> = { currency: cur };
    // value alimenta o ROAS (Purchase) e o valor do AddToCart. Enviado nos DOIS
    // eventos sempre que houver um número válido (>= 0), com 2 casas decimais.
    const value = this.num(doc.valor);
    if (value != null && Number.isFinite(value) && value >= 0) {
      custom_data.value = Math.round(value * 100) / 100;
    }
    if (contents.length) {
      custom_data.contents = contents;
      custom_data.content_type = 'product';
      custom_data.content_ids = contents.map((c) => c.id);
      custom_data.num_items = contents.reduce((s, c) => s + (c.quantity || 0), 0);
    }
    if (doc.numero) custom_data.order_id = doc.numero;

    return {
      event_name: eventName,
      event_time: Math.floor(tsMs / 1000),
      // Determinístico p/ deduplicar com o Pixel do site.
      event_id: `${eventName.toLowerCase()}:${doc.id}`,
      action_source: 'system_generated',
      user_data,
      custom_data,
    };
  }

  /**
   * Casa a venda (TinyDocument) ao contato do CRM e devolve os campos usados no
   * user_data. Usa o contact_id gravado no sync; se ausente, tenta um match ao
   * vivo (CPF -> telefone -> e-mail -> nome) e persiste o vinculo de volta
   * (best-effort) para as proximas rodadas e para o CRM. Somente leitura no
   * caminho principal; a persistencia e guardada e nao derruba o envio.
   */
  private async resolveContactForDoc(
    organizationId: string,
    doc: DocForCapi,
  ): Promise<{
    id: string;
    name: string | null;
    phone: string | null;
    email: string | null;
    createdAt: Date | null;
    tracking: Record<string, any>;
  } | null> {
    const load = async (id: string) => {
      const c = await this.prisma.contact.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          createdAt: true,
          metadata: true,
        },
      });
      if (!c) return null;
      return {
        id: c.id,
        name: c.name,
        phone: c.phone,
        email: c.email,
        createdAt: c.createdAt,
        tracking: ((c.metadata as any)?.tracking ?? {}) as Record<string, any>,
      };
    };

    if (doc.contactId) return load(doc.contactId);

    const matched = await this.matchContactId(organizationId, doc);
    if (!matched) return null;

    // Persiste o vinculo encontrado (so quando ainda estiver nulo) — melhora a
    // cobertura futura e reflete o contato no CRM. Best-effort.
    try {
      await this.prisma.tinyDocument.updateMany({
        where: { id: doc.id, contactId: null },
        data: { contactId: matched.id, matchedBy: matched.by },
      });
    } catch (err: any) {
      this.logger.warn(
        `CAPI persist match falhou doc=${doc.id}: ${err?.message ?? err}`,
      );
    }
    return load(matched.id);
  }

  /**
   * Match ao vivo venda->contato, na MESMA ordem/forca do sync do Tiny
   * (CPF -> telefone -> e-mail -> nome). Duplicado aqui de proposito para nao
   * criar dependencia circular com o TinyService (que ja depende deste). Apenas
   * leitura. Retorna o id do contato e a estrategia que casou.
   */
  private async matchContactId(
    organizationId: string,
    doc: DocForCapi,
  ): Promise<{ id: string; by: string } | null> {
    // 1) CPF/CNPJ (metadata: cpfCnpj/cpf/cnpj/documento).
    const cpf = (doc.clienteCpfCnpj ?? '').replace(/\D/g, '');
    if (cpf.length >= 11) {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM contacts
        WHERE organization_id = ${organizationId}
          AND deleted_at IS NULL
          AND regexp_replace(
                COALESCE(metadata->>'cpfCnpj', metadata->>'cpf', metadata->>'cnpj', metadata->>'documento', ''),
                '\\D', '', 'g'
              ) = ${cpf}
        LIMIT 1`;
      if (rows[0]) return { id: rows[0].id, by: 'cpf_cnpj' };
    }

    // 2) Telefone — variacoes com/sem 9o digito, com/sem DDI.
    const variants = phoneVariants(doc.clienteTelefone);
    if (variants.length) {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM contacts
        WHERE organization_id = ${organizationId}
          AND deleted_at IS NULL
          AND phone IS NOT NULL
          AND regexp_replace(phone, '\\D', '', 'g') = ANY(${variants})
        LIMIT 1`;
      if (rows[0]) return { id: rows[0].id, by: 'phone' };
    }

    // 3) E-mail (case-insensitive).
    const email = (doc.clienteEmail || '').trim().toLowerCase();
    if (email.includes('@')) {
      const c = await this.prisma.contact.findFirst({
        where: {
          organizationId,
          deletedAt: null,
          email: { equals: email, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (c) return { id: c.id, by: 'email' };
    }

    // 4) Nome exato (case-insensitive) — fallback fraco, ultimo recurso.
    const nome = (doc.clienteNome || '').trim();
    if (nome.length >= 4) {
      const c = await this.prisma.contact.findFirst({
        where: {
          organizationId,
          deletedAt: null,
          name: { equals: nome, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (c) return { id: c.id, by: 'name' };
    }
    return null;
  }

  private num(v: any): number | null {
    if (v == null) return null;
    const n = typeof v === 'number' ? v : Number(v);
    return isNaN(n) ? null : n;
  }
}

/** Envolve um hash em array (formato que a Meta espera pra user_data). */
function arr(v?: string): string[] | undefined {
  return v ? [v] : undefined;
}
