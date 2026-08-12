import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { TinyHttpClient } from './tiny.http-client';
import { MetaCapiService } from './meta-capi/meta-capi.service';

/** Situações de pedido do Tiny v3 (código → rótulo). */
const PEDIDO_SITUACOES: Record<string, string> = {
  '8': 'Dados Incompletos',
  '0': 'Aberta',
  '3': 'Aprovada',
  '4': 'Preparando Envio',
  '1': 'Faturada',
  '7': 'Pronto Envio',
  '5': 'Enviada',
  '6': 'Entregue',
  '2': 'Cancelada',
  '9': 'Não Entregue',
};

/** Situações de pedido que NÃO contam como venda efetiva. */
const PEDIDO_STATUS_EXCLUIDOS = ['Cancelada', 'Dados Incompletos'];

/** Canais de venda (marketplaces) cuja origem deve ser excluída da tela. */
const MARKETPLACE_RE =
  /(mercado ?livre|shopee|magalu|magazine ?luiza|amazon|americanas|b2w|via ?varejo)/i;

interface DateRange {
  gte?: Date;
  lte?: Date;
}

interface MatchInput {
  cpfCnpj?: string | null;
  phone?: string | null;
  email?: string | null;
  nome?: string | null;
}
interface MatchResult {
  contactId: string;
  matchedBy: 'cpf_cnpj' | 'phone' | 'email' | 'name';
}

@Injectable()
export class TinyService {
  private readonly logger = new Logger(TinyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly http: TinyHttpClient,
    private readonly config: ConfigService,
    private readonly metaCapi: MetaCapiService,
  ) {}

  // ── OAuth ──────────────────────────────────────────────────────────

  /** Inicia o OAuth: garante a linha de integração e devolve a URL de consentimento. */
  async startOAuth(organizationId: string): Promise<{ url: string }> {
    await this.prisma.tinyIntegration.upsert({
      where: { organizationId },
      create: { organizationId, status: 'pending' },
      update: {},
    });
    const state = this.signState(organizationId);
    return { url: this.http.buildAuthorizeUrl(state) };
  }

  /** Callback do OAuth: valida o state, troca o code por tokens e ativa. */
  async handleCallback(code: string, state: string): Promise<{ organizationId: string }> {
    const organizationId = this.verifyState(state);
    if (!organizationId) throw new BadRequestException('State inválido');
    await this.prisma.tinyIntegration.upsert({
      where: { organizationId },
      create: { organizationId, status: 'pending' },
      update: {},
    });
    const tokens = await this.http.exchangeCode(code);
    await this.http.persistTokens(organizationId, tokens);
    // Nome da conta (best-effort).
    const info = await this.http.getContaEmpresa(organizationId);
    const accountName = info?.nome || info?.razaoSocial || info?.nomeFantasia || null;
    if (accountName) {
      await this.prisma.tinyIntegration.update({
        where: { organizationId },
        data: { accountName },
      });
    }
    return { organizationId };
  }

  async getStatus(organizationId: string) {
    const integ = await this.prisma.tinyIntegration.findUnique({
      where: { organizationId },
    });
    if (!integ) return { connected: false as const };
    return {
      connected: integ.status === 'active',
      status: integ.status,
      accountName: integ.accountName,
      lastPedidosSyncAt: integ.lastPedidosSyncAt,
      lastOrcamentosSyncAt: integ.lastOrcamentosSyncAt,
      lastError: integ.lastError,
    };
  }

  async disconnect(organizationId: string): Promise<void> {
    await this.prisma.tinyIntegration.updateMany({
      where: { organizationId },
      data: { status: 'revoked', accessToken: null, refreshToken: null },
    });
  }

  private stateSecret(): string {
    return (
      this.config.get<string>('JWT_SECRET') ||
      this.config.get<string>('TINY_STATE_SECRET') ||
      'tiny-state'
    );
  }
  private signState(organizationId: string): string {
    const sig = crypto
      .createHmac('sha256', this.stateSecret())
      .update(organizationId)
      .digest('base64url');
    return `${Buffer.from(organizationId).toString('base64url')}.${sig}`;
  }
  private verifyState(state: string): string | null {
    const [b64, sig] = (state || '').split('.');
    if (!b64 || !sig) return null;
    const organizationId = Buffer.from(b64, 'base64url').toString('utf8');
    const expected = crypto
      .createHmac('sha256', this.stateSecret())
      .update(organizationId)
      .digest('base64url');
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))
      ? organizationId
      : null;
  }

  // ── Sync ───────────────────────────────────────────────────────────

  /**
   * Sincroniza pedidos e orçamentos da org: incremental por data, casa cada
   * documento com um Contact e faz upsert em TinyDocument. Best-effort e
   * idempotente — reexecutar não duplica (unique org+kind+tinyId).
   */
  async syncNow(organizationId: string): Promise<{ pedidos: number; orcamentos: number }> {
    const integ = await this.prisma.tinyIntegration.findUnique({
      where: { organizationId },
    });
    if (!integ || integ.status !== 'active') {
      throw new BadRequestException('Integração Tiny não conectada');
    }

    let pedidos = 0;
    let orcamentos = 0;
    try {
      pedidos = await this.syncPedidos(organizationId, integ.lastPedidosSyncAt);
      orcamentos = await this.syncOrcamentos(organizationId, integ.lastOrcamentosSyncAt);
      // Enriquecimento sob demanda (natureza do pedido + vendedor do orçamento),
      // lote pequeno por rodada pra respeitar o rate limit do Tiny (120/min) —
      // o cron (15min) completa o resto ao longo dos ciclos. Isolado: falha
      // aqui NÃO derruba o sync nem impede o avanço dos watermarks.
      try {
        await this.enrichDetails(organizationId, 40);
      } catch (err: any) {
        this.logger.warn(`enrichDetails falhou (best-effort): ${err?.message ?? err}`);
      }
      // Meta CAPI: emite Purchase/AddToCart pros documentos que casam com a
      // config (no-op se desligado). Isolado — nunca derruba o sync.
      try {
        await this.metaCapi.emitPending(organizationId);
      } catch (err: any) {
        this.logger.warn(`CAPI emitPending falhou (best-effort): ${err?.message ?? err}`);
      }
      await this.prisma.tinyIntegration.update({
        where: { organizationId },
        data: {
          lastPedidosSyncAt: new Date(),
          lastOrcamentosSyncAt: new Date(),
          lastError: null,
        },
      });
    } catch (err: any) {
      await this.prisma.tinyIntegration.update({
        where: { organizationId },
        data: { lastError: String(err?.message ?? err).slice(0, 500) },
      });
      throw err;
    }
    return { pedidos, orcamentos };
  }

  private ymd(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  private async syncPedidos(organizationId: string, since: Date | null): Promise<number> {
    // Overlap de 1 dia pra não perder nada por fuso/atraso. 1ª carga: 90 dias.
    const from = since
      ? new Date(since.getTime() - 24 * 3600 * 1000)
      : new Date(Date.now() - 90 * 24 * 3600 * 1000);
    const dataAtualizacao = this.ymd(from);

    let offset = 0;
    const limit = 100;
    let total = Infinity;
    let count = 0;
    while (offset < total) {
      const page = await this.http.listarPedidos(organizationId, {
        offset,
        limit,
        dataAtualizacao,
      });
      const itens = page.itens ?? [];
      total = page.paginacao?.total ?? itens.length;
      for (const p of itens) {
        await this.upsertPedido(organizationId, p);
        count++;
      }
      if (itens.length < limit) break;
      offset += limit;
    }
    return count;
  }

  private async upsertPedido(organizationId: string, p: any): Promise<void> {
    const cli = p?.cliente ?? {};
    const phone = cli.celular || cli.telefone || null;
    const match = await this.matchContact(organizationId, {
      cpfCnpj: cli.cpfCnpj,
      phone,
      email: cli.email,
      nome: cli.nome,
    });
    const situacao = PEDIDO_SITUACOES[String(p?.situacao)] ?? String(p?.situacao ?? '');
    const isMkt = this.isMarketplace(p?.ecommerce);
    const vendedor = p?.vendedor?.nome ?? null;
    const common = {
      numero: p?.numeroPedido != null ? String(p.numeroPedido) : null,
      situacao,
      data: this.parseDate(p?.dataCriacao),
      valor: this.parseDecimal(p?.valor),
      clienteNome: cli.nome ?? null,
      clienteCpfCnpj: this.digits(cli.cpfCnpj) || null,
      clienteTelefone: phone,
      clienteEmail: cli.email ?? null,
      tinyContatoId: cli.id != null ? String(cli.id) : null,
      isMarketplace: isMkt,
      vendedor,
      contactId: match?.contactId ?? null,
      matchedBy: match?.matchedBy ?? null,
      raw: p,
    };
    await this.prisma.tinyDocument.upsert({
      where: {
        uq_tinydoc_org_kind_tinyid: {
          organizationId,
          kind: 'PEDIDO',
          tinyId: String(p.id),
        },
      },
      create: { organizationId, kind: 'PEDIDO', tinyId: String(p.id), ...common },
      // natureza NÃO é sobrescrita aqui (vem do enriquecimento). vendedor só
      // atualiza se veio na listagem (senão preserva o que o detalhe trouxe).
      update: { ...common, ...(vendedor ? {} : { vendedor: undefined }) },
    });
  }

  /** True quando a origem do pedido é um marketplace (ML/Shopee/Magalu/Amazon…). */
  private isMarketplace(ecommerce: any): boolean {
    const s = `${ecommerce?.nome ?? ''} ${ecommerce?.canalVenda ?? ''}`.trim();
    return !!s && MARKETPLACE_RE.test(s);
  }

  private async syncOrcamentos(organizationId: string, since: Date | null): Promise<number> {
    const from = since
      ? new Date(since.getTime() - 24 * 3600 * 1000)
      : new Date(Date.now() - 90 * 24 * 3600 * 1000);
    const dataInicio = this.ymd(from);
    const dataFim = this.ymd(new Date(Date.now() + 24 * 3600 * 1000));

    // Cache de contatos do Tiny resolvidos nesta rodada (evita N chamadas).
    const contatoCache = new Map<string, any>();

    let offset = 0;
    const limit = 100;
    let total = Infinity;
    let count = 0;
    while (offset < total) {
      const page = await this.http.listarOrcamentos(organizationId, {
        offset,
        limit,
        dataInicio,
        dataFim,
      });
      const itens = page.itens ?? [];
      total = page.paginacao?.total ?? itens.length;
      for (const o of itens) {
        await this.upsertOrcamento(organizationId, o, contatoCache);
        count++;
      }
      if (itens.length < limit) break;
      offset += limit;
    }
    return count;
  }

  private async upsertOrcamento(
    organizationId: string,
    o: any,
    cache: Map<string, any>,
  ): Promise<void> {
    // O orçamento traz só contato.id — resolve o contato completo (com cache).
    const contatoId = o?.contato?.id != null ? String(o.contato.id) : null;
    let cli: any = {};
    if (contatoId) {
      if (cache.has(contatoId)) {
        cli = cache.get(contatoId);
      } else {
        try {
          cli = (await this.http.getContato(organizationId, contatoId)) ?? {};
        } catch (err: any) {
          this.logger.warn(
            `Falha ao resolver contato Tiny #${contatoId}: ${err?.message ?? err}`,
          );
          cli = {};
        }
        cache.set(contatoId, cli);
      }
    }
    const phone = cli.celular || cli.telefone || cli.fone || null;
    const match = await this.matchContact(organizationId, {
      cpfCnpj: cli.cpfCnpj,
      phone,
      email: cli.email,
      nome: cli.nome,
    });
    await this.prisma.tinyDocument.upsert({
      where: {
        uq_tinydoc_org_kind_tinyid: {
          organizationId,
          kind: 'ORCAMENTO',
          tinyId: String(o.id),
        },
      },
      create: {
        organizationId,
        kind: 'ORCAMENTO',
        tinyId: String(o.id),
        numero: o?.numeroProposta != null ? String(o.numeroProposta) : null,
        situacao: o?.situacao ?? null,
        data: this.parseDate(o?.data),
        valor: this.parseDecimal(o?.valorTotal),
        clienteNome: cli.nome ?? null,
        clienteCpfCnpj: this.digits(cli.cpfCnpj) || null,
        clienteTelefone: phone,
        clienteEmail: cli.email ?? null,
        tinyContatoId: contatoId,
        contactId: match?.contactId ?? null,
        matchedBy: match?.matchedBy ?? null,
        raw: o,
      },
      update: {
        numero: o?.numeroProposta != null ? String(o.numeroProposta) : null,
        situacao: o?.situacao ?? null,
        data: this.parseDate(o?.data),
        valor: this.parseDecimal(o?.valorTotal),
        clienteNome: cli.nome ?? null,
        clienteCpfCnpj: this.digits(cli.cpfCnpj) || null,
        clienteTelefone: phone,
        clienteEmail: cli.email ?? null,
        tinyContatoId: contatoId,
        contactId: match?.contactId ?? null,
        matchedBy: match?.matchedBy ?? null,
        raw: o,
      },
    });
  }

  // ── Matching lead ──────────────────────────────────────────────────

  /**
   * Casa o cliente do documento Tiny com um Contact do CRM, na ordem de
   * confiabilidade: CPF/CNPJ → telefone (com variação do 9º dígito) → email →
   * nome (fallback). Retorna o 1º match ou null.
   */
  private async matchContact(
    organizationId: string,
    input: MatchInput,
  ): Promise<MatchResult | null> {
    // 1) CPF/CNPJ (procura em metadata: cpfCnpj/cpf/cnpj/documento).
    const doc = this.digits(input.cpfCnpj);
    if (doc && doc.length >= 11) {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM contacts
        WHERE organization_id = ${organizationId}
          AND deleted_at IS NULL
          AND regexp_replace(
                COALESCE(metadata->>'cpfCnpj', metadata->>'cpf', metadata->>'cnpj', metadata->>'documento', ''),
                '\\D', '', 'g'
              ) = ${doc}
        LIMIT 1`;
      if (rows[0]) return { contactId: rows[0].id, matchedBy: 'cpf_cnpj' };
    }

    // 2) Telefone — compara pelos últimos 8 dígitos (assinante) + DDD, tolerando
    //    o 9º dígito (WhatsApp sem o 9 x formulário com o 9).
    const variants = this.phoneVariants(input.phone);
    if (variants.length) {
      const rows = await this.prisma.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM contacts
        WHERE organization_id = ${organizationId}
          AND deleted_at IS NULL
          AND phone IS NOT NULL
          AND regexp_replace(phone, '\\D', '', 'g') = ANY(${variants})
        LIMIT 1`;
      if (rows[0]) return { contactId: rows[0].id, matchedBy: 'phone' };
    }

    // 3) Email (case-insensitive).
    const email = (input.email || '').trim().toLowerCase();
    if (email && email.includes('@')) {
      const c = await this.prisma.contact.findFirst({
        where: {
          organizationId,
          deletedAt: null,
          email: { equals: email, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (c) return { contactId: c.id, matchedBy: 'email' };
    }

    // 4) Nome exato (case-insensitive) — fallback fraco, último recurso.
    const nome = (input.nome || '').trim();
    if (nome.length >= 4) {
      const c = await this.prisma.contact.findFirst({
        where: {
          organizationId,
          deletedAt: null,
          name: { equals: nome, mode: 'insensitive' },
        },
        select: { id: true },
      });
      if (c) return { contactId: c.id, matchedBy: 'name' };
    }

    return null;
  }

  /**
   * Variações de um telefone BR pra casar com o Contact:
   * normaliza pra dígitos, tira DDI 55, e gera com/sem o 9º dígito no celular.
   * Ex.: "(62) 99225-5724" → ["5562992255724","62992255724","6292255724", ...].
   */
  private phoneVariants(phone?: string | null): string[] {
    let d = this.digits(phone);
    if (!d) return [];
    if (d.startsWith('55') && d.length >= 12) d = d.slice(2); // tira DDI
    // Agora esperamos DDD(2) + número(8 ou 9). Gera os dois formatos.
    const out = new Set<string>();
    const add = (v: string) => {
      if (v.length >= 10) {
        out.add(v);
        out.add('55' + v);
      }
    };
    if (d.length >= 10) {
      const ddd = d.slice(0, 2);
      let num = d.slice(2);
      // com 9º dígito
      if (num.length === 8) add(ddd + '9' + num);
      else add(ddd + num);
      // sem 9º dígito
      if (num.length === 9 && num.startsWith('9')) add(ddd + num.slice(1));
      else add(ddd + num);
    }
    return [...out];
  }

  private digits(v?: string | null): string {
    return (v ?? '').replace(/\D/g, '');
  }
  private parseDate(v?: string | null): Date | null {
    if (!v) return null;
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  private parseDecimal(v?: string | number | null): number | null {
    if (v == null) return null;
    if (typeof v === 'number') return isNaN(v) ? null : v;
    let s = String(v).trim();
    if (!s) return null;
    // O Tiny v3 manda decimal no formato AMERICANO: ponto é o separador
    // decimal e NÃO há separador de milhar (ex.: "5234.12", "495.4"). Só
    // convertemos de formato BR ("5.234,12") quando houver vírgula — aí o
    // ponto é milhar. Antes removíamos TODO ponto, o que inflava 100x.
    if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  // ── Leitura pro painel ─────────────────────────────────────────────

  /** Converte from/to (ISO/date) num filtro de data pro Prisma. */
  private buildRange(from?: string, to?: string): DateRange | undefined {
    const gte = from ? new Date(from) : undefined;
    const lte = to ? new Date(to) : undefined;
    const range: DateRange = {};
    if (gte && !isNaN(gte.getTime())) range.gte = gte;
    if (lte && !isNaN(lte.getTime())) range.lte = lte;
    return range.gte || range.lte ? range : undefined;
  }

  /**
   * Filtro de PEDIDOS "venda efetiva": exclui Cancelado/Dados Incompletos,
   * exclui origem marketplace e exige natureza de operação "Venda". Aplicado
   * na tela e nos totais pra refletir só vendas reais.
   */
  private pedidoWhere(organizationId: string, range?: DateRange) {
    return {
      organizationId,
      kind: 'PEDIDO',
      situacao: { notIn: PEDIDO_STATUS_EXCLUIDOS },
      isMarketplace: false,
      natureza: { contains: 'venda', mode: 'insensitive' as const },
      ...(range ? { data: range } : {}),
    };
  }

  private orcamentoWhere(organizationId: string, range?: DateRange) {
    return {
      organizationId,
      kind: 'ORCAMENTO',
      ...(range ? { data: range } : {}),
    };
  }

  /**
   * Resumo pros cards do topo: totais (valor + contagem) de pedidos e
   * propostas, mais o breakdown por vendedor. Respeita o período e os filtros
   * de venda efetiva. @example { pedidos:{count,total}, orcamentos:{...},
   * porVendedor:[{ vendedor, pedidosCount, pedidosTotal, propostasCount, propostasTotal }] }
   */
  async summary(organizationId: string, from?: string, to?: string) {
    const range = this.buildRange(from, to);
    const pw = this.pedidoWhere(organizationId, range);
    const ow = this.orcamentoWhere(organizationId, range);

    const [pedidos, orcamentos, vendPed, vendOrc] = await Promise.all([
      this.prisma.tinyDocument.aggregate({
        where: pw,
        _count: { _all: true },
        _sum: { valor: true },
      }),
      this.prisma.tinyDocument.aggregate({
        where: ow,
        _count: { _all: true },
        _sum: { valor: true },
      }),
      this.prisma.tinyDocument.groupBy({
        by: ['vendedor'],
        where: pw,
        _count: { _all: true },
        _sum: { valor: true },
      }),
      this.prisma.tinyDocument.groupBy({
        by: ['vendedor'],
        where: ow,
        _count: { _all: true },
        _sum: { valor: true },
      }),
    ]);

    // Une pedidos e propostas por nome de vendedor.
    const byVend = new Map<
      string,
      { vendedor: string; pedidosCount: number; pedidosTotal: number; propostasCount: number; propostasTotal: number }
    >();
    const key = (v: string | null) => v?.trim() || 'Sem vendedor';
    for (const r of vendPed) {
      const k = key(r.vendedor);
      const e = byVend.get(k) ?? { vendedor: k, pedidosCount: 0, pedidosTotal: 0, propostasCount: 0, propostasTotal: 0 };
      e.pedidosCount += r._count._all;
      e.pedidosTotal += Number(r._sum.valor ?? 0);
      byVend.set(k, e);
    }
    for (const r of vendOrc) {
      const k = key(r.vendedor);
      const e = byVend.get(k) ?? { vendedor: k, pedidosCount: 0, pedidosTotal: 0, propostasCount: 0, propostasTotal: 0 };
      e.propostasCount += r._count._all;
      e.propostasTotal += Number(r._sum.valor ?? 0);
      byVend.set(k, e);
    }
    const porVendedor = [...byVend.values()].sort((a, b) => b.pedidosTotal - a.pedidosTotal);

    return {
      pedidos: { count: pedidos._count._all, total: Number(pedidos._sum.valor ?? 0) },
      orcamentos: { count: orcamentos._count._all, total: Number(orcamentos._sum.valor ?? 0) },
      porVendedor,
    };
  }

  /**
   * Enriquecimento sob demanda via detalhe do Tiny (capado por rodada):
   *  - PEDIDO candidato (não cancelado/incompleto, não-marketplace) sem
   *    natureza → busca detalhe e preenche natureza (+ vendedor se faltar).
   *  - ORÇAMENTO sem vendedor → busca detalhe e preenche vendedor.
   * Best-effort: falha numa não derruba as outras. O cron completa ao longo
   * dos ciclos (rows que continuam nulas são retentadas).
   */
  private async enrichDetails(organizationId: string, limit: number): Promise<void> {
    const half = Math.ceil(limit / 2);
    const [pedidos, orcamentos] = await Promise.all([
      this.prisma.tinyDocument.findMany({
        where: {
          organizationId,
          kind: 'PEDIDO',
          natureza: null,
          isMarketplace: false,
          situacao: { notIn: PEDIDO_STATUS_EXCLUIDOS },
        },
        select: { id: true, tinyId: true, vendedor: true },
        take: half,
      }),
      this.prisma.tinyDocument.findMany({
        where: { organizationId, kind: 'ORCAMENTO', vendedor: null },
        select: { id: true, tinyId: true },
        take: half,
      }),
    ]);

    for (const d of pedidos) {
      try {
        const det = await this.http.getPedido(organizationId, d.tinyId);
        await this.prisma.tinyDocument.update({
          where: { id: d.id },
          data: {
            natureza: det?.naturezaOperacao?.nome ?? '—',
            ...(d.vendedor ? {} : { vendedor: det?.vendedor?.nome ?? null }),
          },
        });
      } catch (err: any) {
        this.logger.warn(`enrich pedido ${d.tinyId} falhou: ${err?.message ?? err}`);
      }
    }
    for (const d of orcamentos) {
      try {
        const det = await this.http.getOrcamento(organizationId, d.tinyId);
        // '—' pra sinalizar "resolvido sem vendedor" e não retentar pra sempre.
        await this.prisma.tinyDocument.update({
          where: { id: d.id },
          data: { vendedor: det?.vendedor?.nome ?? '—' },
        });
      } catch (err: any) {
        this.logger.warn(`enrich orçamento ${d.tinyId} falhou: ${err?.message ?? err}`);
      }
    }
  }

  /**
   * Listagem paginada de documentos por tipo, com o LEAD vinculado (contato do
   * CRM) já embutido — pronto pra tabela do frontend. Ordena por data desc.
   */
  async listDocuments(
    organizationId: string,
    kind: 'PEDIDO' | 'ORCAMENTO',
    page = 1,
    limit = 30,
    from?: string,
    to?: string,
  ) {
    const range = this.buildRange(from, to);
    const where =
      kind === 'PEDIDO'
        ? this.pedidoWhere(organizationId, range)
        : this.orcamentoWhere(organizationId, range);
    const take = Math.min(Math.max(limit, 1), 100);
    const skip = (Math.max(page, 1) - 1) * take;
    const [total, rows] = await Promise.all([
      this.prisma.tinyDocument.count({ where }),
      this.prisma.tinyDocument.findMany({
        where,
        orderBy: [{ data: 'desc' }, { createdAt: 'desc' }],
        skip,
        take,
        include: {
          contact: { select: { id: true, name: true, phone: true, email: true } },
        },
      }),
    ]);
    return {
      items: rows.map((d) => ({
        id: d.id,
        kind: d.kind,
        tinyId: d.tinyId,
        numero: d.numero,
        situacao: d.situacao,
        data: d.data,
        valor: d.valor != null ? Number(d.valor) : null,
        clienteNome: d.clienteNome,
        clienteTelefone: d.clienteTelefone,
        vendedor: d.vendedor,
        matchedBy: d.matchedBy,
        // Lead vinculado do CRM (null quando não casou).
        lead: d.contact
          ? { id: d.contact.id, name: d.contact.name, phone: d.contact.phone }
          : null,
      })),
      pagination: {
        page: Math.max(page, 1),
        limit: take,
        total,
        totalPages: Math.max(1, Math.ceil(total / take)),
      },
    };
  }

  /**
   * Itens de um documento (pedido/orçamento) — buscados SOB DEMANDA no Tiny
   * (o detalhe traz `itens`, a listagem não). Usado pela linha expansível.
   * Normaliza pro shape { descricao, sku, quantidade, valorUnitario, valorTotal }.
   */
  async getItems(organizationId: string, docId: string) {
    const doc = await this.prisma.tinyDocument.findFirst({
      where: { id: docId, organizationId },
      select: { kind: true, tinyId: true },
    });
    if (!doc) throw new BadRequestException('Documento não encontrado');

    const detail =
      doc.kind === 'PEDIDO'
        ? await this.http.getPedido(organizationId, doc.tinyId)
        : await this.http.getOrcamento(organizationId, doc.tinyId);

    const itens: any[] = Array.isArray(detail?.itens) ? detail.itens : [];

    const totalProdutos = this.parseDecimal(detail?.valorTotalProdutos);
    const desconto = this.parseDecimal(detail?.valorDesconto);

    // Pagamento pode vir num objeto `pagamento` ou espalhado no detalhe / nas
    // parcelas. Loga as chaves uma vez pra confirmar o shape real nos logs.
    const pg = detail?.pagamento ?? {};
    const parcela0 = Array.isArray(pg?.parcelas) ? pg.parcelas[0] : undefined;
    if (pg && Object.keys(pg).length) {
      this.logger.debug(
        `tiny pagamento shape (doc ${docId}): ${JSON.stringify(Object.keys(pg))}` +
          (parcela0 ? ` parcela0=${JSON.stringify(Object.keys(parcela0))}` : ''),
      );
    }

    return {
      items: itens.map((it) => {
        const prod = it?.produto ?? {};
        const qtd = Number(it?.quantidade ?? 0);
        const unit = Number(it?.valorUnitario ?? it?.valor ?? 0);
        return {
          descricao: prod.descricao ?? it?.descricao ?? '(sem descrição)',
          sku: prod.sku ?? it?.codigo ?? null,
          quantidade: qtd,
          valorUnitario: unit,
          valorTotal: Number((qtd * unit).toFixed(2)),
          infoAdicional: it?.infoAdicional ?? null,
        };
      }),
      // Resumo financeiro do pedido (do detalhe). Nomes da v3; caem pra
      // alternativas quando o recurso é orçamento.
      resumo: {
        totalProdutos,
        desconto,
        // % de desconto: usa o nativo do Tiny quando houver; senão deriva
        // do valor sobre o total de produtos (ex.: 693,79 / 5.781,58 = 12%).
        descontoPercent: this.tinyDescontoPercent(detail, totalProdutos, desconto),
        frete: this.parseDecimal(detail?.valorFrete),
        outrasDespesas: this.parseDecimal(detail?.valorOutrasDespesas),
        total: this.parseDecimal(
          detail?.valorTotalPedido ?? detail?.valorTotal ?? detail?.valorTotalProdutos,
        ),
        condicaoPagamento:
          pg?.condicaoPagamento ?? detail?.condicaoPagamento ?? null,
        // Forma de recebimento / meio / conta bancária (defensivo em múltiplos
        // caminhos do payload; null quando ausente → UI esconde).
        formaRecebimento: this.pickStr(
          pg?.formaPagamento?.nome,
          pg?.formaPagamento,
          parcela0?.formaPagamento?.nome,
          parcela0?.formaPagamento,
          detail?.formaPagamento?.nome,
          detail?.formaPagamento,
        ),
        meioPagamento: this.pickStr(
          pg?.meioPagamento?.nome,
          pg?.meioPagamento,
          parcela0?.meioPagamento?.nome,
          parcela0?.meioPagamento,
          detail?.meioPagamento?.nome,
          detail?.meioPagamento,
        ),
        contaBancaria: this.pickStr(
          pg?.conta?.nome,
          pg?.contaBancaria?.nome,
          pg?.nomeConta,
          parcela0?.conta?.nome,
          parcela0?.contaBancaria?.nome,
          parcela0?.nomeConta,
          detail?.conta?.nome,
          detail?.contaBancaria?.nome,
        ),
      },
    };
  }

  /** Primeiro valor string não-vazio dentre os candidatos. */
  private pickStr(...candidates: any[]): string | null {
    for (const c of candidates) {
      if (typeof c === 'string' && c.trim()) return c.trim();
    }
    return null;
  }

  /** % de desconto do pedido: nativo do Tiny ou derivado (valor/total). */
  private tinyDescontoPercent(
    detail: any,
    totalProdutos: number | null,
    desconto: number | null,
  ): number | null {
    // Campos nativos possíveis (número ou string tipo "12" / "12,00%").
    const nativo =
      detail?.percentualDesconto ??
      detail?.descontoPercentual ??
      (typeof detail?.desconto === 'string' && detail.desconto.includes('%')
        ? detail.desconto
        : undefined);
    if (nativo != null) {
      const n = parseFloat(String(nativo).replace('%', '').replace(',', '.'));
      if (Number.isFinite(n) && n > 0) return Number(n.toFixed(2));
    }
    // Deriva do valor sobre o total de produtos.
    if (totalProdutos && totalProdutos > 0 && desconto && desconto > 0) {
      return Number(((desconto / totalProdutos) * 100).toFixed(2));
    }
    return null;
  }

  /** Documentos (pedidos + orçamentos) vinculados a um contato, mais recentes primeiro. */
  async listForContact(organizationId: string, contactId: string) {
    const docs = await this.prisma.tinyDocument.findMany({
      where: { organizationId, contactId },
      orderBy: [{ data: 'desc' }, { createdAt: 'desc' }],
      take: 100,
    });
    return {
      pedidos: docs.filter((d) => d.kind === 'PEDIDO'),
      orcamentos: docs.filter((d) => d.kind === 'ORCAMENTO'),
    };
  }
}
