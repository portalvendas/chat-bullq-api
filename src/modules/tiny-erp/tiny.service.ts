import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { TinyHttpClient } from './tiny.http-client';

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
    await this.prisma.tinyDocument.upsert({
      where: {
        uq_tinydoc_org_kind_tinyid: {
          organizationId,
          kind: 'PEDIDO',
          tinyId: String(p.id),
        },
      },
      create: {
        organizationId,
        kind: 'PEDIDO',
        tinyId: String(p.id),
        numero: p?.numeroPedido != null ? String(p.numeroPedido) : null,
        situacao,
        data: this.parseDate(p?.dataCriacao),
        valor: this.parseDecimal(p?.valor),
        clienteNome: cli.nome ?? null,
        clienteCpfCnpj: this.digits(cli.cpfCnpj) || null,
        clienteTelefone: phone,
        clienteEmail: cli.email ?? null,
        tinyContatoId: cli.id != null ? String(cli.id) : null,
        contactId: match?.contactId ?? null,
        matchedBy: match?.matchedBy ?? null,
        raw: p,
      },
      update: {
        numero: p?.numeroPedido != null ? String(p.numeroPedido) : null,
        situacao,
        data: this.parseDate(p?.dataCriacao),
        valor: this.parseDecimal(p?.valor),
        clienteNome: cli.nome ?? null,
        clienteCpfCnpj: this.digits(cli.cpfCnpj) || null,
        clienteTelefone: phone,
        clienteEmail: cli.email ?? null,
        tinyContatoId: cli.id != null ? String(cli.id) : null,
        contactId: match?.contactId ?? null,
        matchedBy: match?.matchedBy ?? null,
        raw: p,
      },
    });
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
    const n =
      typeof v === 'number'
        ? v
        : parseFloat(String(v).replace(/\./g, '').replace(',', '.'));
    return isNaN(n) ? null : n;
  }

  // ── Leitura pro painel ─────────────────────────────────────────────

  /**
   * Resumo pros cards do topo da tela: soma de valores e contagem, por tipo.
   * @example { pedidos: { count: 523, total: 184230.50 }, orcamentos: {...} }
   */
  async summary(organizationId: string) {
    const [pedidos, orcamentos] = await Promise.all([
      this.prisma.tinyDocument.aggregate({
        where: { organizationId, kind: 'PEDIDO' },
        _count: { _all: true },
        _sum: { valor: true },
      }),
      this.prisma.tinyDocument.aggregate({
        where: { organizationId, kind: 'ORCAMENTO' },
        _count: { _all: true },
        _sum: { valor: true },
      }),
    ]);
    return {
      pedidos: {
        count: pedidos._count._all,
        total: Number(pedidos._sum.valor ?? 0),
      },
      orcamentos: {
        count: orcamentos._count._all,
        total: Number(orcamentos._sum.valor ?? 0),
      },
    };
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
  ) {
    const take = Math.min(Math.max(limit, 1), 100);
    const skip = (Math.max(page, 1) - 1) * take;
    const [total, rows] = await Promise.all([
      this.prisma.tinyDocument.count({ where: { organizationId, kind } }),
      this.prisma.tinyDocument.findMany({
        where: { organizationId, kind },
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
    };
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
