import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { TinyService } from '../tiny-erp/tiny.service';
import { buildXlsx, H, S, N } from '../dashboard/xlsx-lite.util';
import type { Cell } from '../dashboard/xlsx-lite.util';
import { calcCommission, monthRange, type PercentBase } from './commission.calc';

/** Mesma regra de "venda efetiva" do Pedidos & Propostas. */
const EXCLUIDOS = ['Cancelada', 'Dados Incompletos', 'Removido'];
const SEM_VENDEDOR = 'Sem vendedor';
/** Pedido com produtos/frete já lidos do Tiny PARA O VALOR ATUAL do pedido. */
const APURADO = Prisma.raw(
  `(frete_checked_at IS NOT NULL AND valor_produtos IS NOT NULL AND frete_valor_ref IS NOT DISTINCT FROM valor)`,
);
/** Produtos líquidos (produtos − desconto); sem apuração, o valor do pedido. */
const PRODUTOS = Prisma.raw(`CASE WHEN ${'(frete_checked_at IS NOT NULL AND valor_produtos IS NOT NULL AND frete_valor_ref IS NOT DISTINCT FROM valor)'} THEN valor_produtos ELSE valor END`);
/** Frete do pedido (0 enquanto não apurado). */
const FRETE = Prisma.raw(`CASE WHEN ${'(frete_checked_at IS NOT NULL AND valor_produtos IS NOT NULL AND frete_valor_ref IS NOT DISTINCT FROM valor)'} THEN COALESCE(valor_frete, 0) ELSE 0 END`);

/** Vendedor normalizado: vazio, "—" e NULL viram "Sem vendedor" (1 grupo só). */
const VEND_EXPR = Prisma.raw(
  `CASE WHEN vendedor IS NULL OR TRIM(vendedor) IN ('', '—') THEN '${SEM_VENDEDOR}' ELSE TRIM(vendedor) END`,
);

export interface PlanInput {
  vendedor: string;
  userId?: string | null;
  active?: boolean;
  fixedAmount?: number;
  goalAmount?: number;
  percent?: number;
  percentBase?: PercentBase;
  keepFixed?: boolean;
  notes?: string | null;
}

interface SalesRow {
  vendedor: string;
  pedidos: number;
  /** Valor total dos pedidos (como no Tiny). */
  bruto: number;
  /** Produtos líquidos (produtos − desconto). */
  produtos: number;
  frete: number;
  /** Base da comissão = produtos líquidos − frete (por pedido, mínimo 0). */
  base: number;
  pendentes: number;
}

/**
 * Comissões por vendedor (acesso SÓ do dono — o controller exige OWNER).
 * Vendas = pedidos de VENDA DIRETA do Tiny no mês (sem marketplace, natureza
 * "Venda", não cancelados), pelo vendedor do pedido, SÓ PRODUTOS (sem frete).
 */
@Injectable()
export class CommissionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tiny: TinyService,
  ) {}

  // ── Regras ─────────────────────────────────────────────────────────

  async listPlans(org: string) {
    const [plans, vendRows, users] = await Promise.all([
      this.prisma.commissionPlan.findMany({ where: { organizationId: org }, orderBy: { vendedor: 'asc' } }),
      this.prisma.$queryRaw<{ vendedor: string }[]>`
        SELECT DISTINCT TRIM(vendedor) AS vendedor FROM tiny_documents
        WHERE organization_id = ${org} AND kind = 'PEDIDO' AND vendedor IS NOT NULL
          AND TRIM(vendedor) NOT IN ('', '—')
          AND data >= now() - interval '365 days'
        ORDER BY 1`,
      this.prisma.userOrganization.findMany({
        where: { organizationId: org },
        select: { user: { select: { id: true, name: true } } },
      }),
    ]);
    return {
      plans: plans.map((p) => this.planOut(p)),
      vendedores: vendRows.map((r) => r.vendedor),
      users: users.map((u) => u.user).sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async upsertPlan(org: string, dto: PlanInput) {
    const vendedor = String(dto.vendedor ?? '').trim();
    if (!vendedor) throw new BadRequestException('Informe o vendedor');
    const base: PercentBase = dto.percentBase === 'TOTAL' ? 'TOTAL' : 'EXCEDENTE';
    const num = (v: any, max = 1e9) => {
      const n = Number(v ?? 0);
      if (!Number.isFinite(n) || n < 0 || n > max) throw new BadRequestException('Valor inválido');
      return n;
    };
    const data = {
      userId: dto.userId || null,
      active: dto.active ?? true,
      fixedAmount: num(dto.fixedAmount),
      goalAmount: num(dto.goalAmount),
      percent: num(dto.percent, 100),
      percentBase: base,
      keepFixed: dto.keepFixed ?? true,
      notes: dto.notes?.trim() || null,
    };
    const p = await this.prisma.commissionPlan.upsert({
      where: { uq_commission_plan_org_vendedor: { organizationId: org, vendedor } },
      create: { organizationId: org, vendedor, ...data },
      update: data,
    });
    return this.planOut(p);
  }

  async deletePlan(org: string, id: string) {
    const r = await this.prisma.commissionPlan.deleteMany({ where: { id, organizationId: org } });
    if (!r.count) throw new NotFoundException('Regra não encontrada');
    return { ok: true };
  }

  /** Meta de um mês específico; goalAmount null/vazio remove (volta à padrão). */
  async setGoal(org: string, dto: { vendedor: string; month: string; goalAmount?: number | null }) {
    monthRange(dto.month); // valida AAAA-MM
    const vendedor = String(dto.vendedor ?? '').trim();
    if (!vendedor) throw new BadRequestException('Informe o vendedor');
    const key = { organizationId: org, vendedor, month: dto.month };
    if (dto.goalAmount == null || (dto.goalAmount as any) === '') {
      await this.prisma.commissionGoal.deleteMany({ where: key });
      return { ok: true, goalAmount: null };
    }
    const g = Number(dto.goalAmount);
    if (!Number.isFinite(g) || g < 0) throw new BadRequestException('Meta inválida');
    await this.prisma.commissionGoal.upsert({
      where: { uq_commission_goal_org_vend_month: key },
      create: { ...key, goalAmount: g },
      update: { goalAmount: g },
    });
    return { ok: true, goalAmount: g };
  }

  // ── Apuração ───────────────────────────────────────────────────────

  async report(org: string, month: string) {
    const { from, to } = this.range(month);
    const [plans, goals, sales] = await Promise.all([
      this.prisma.commissionPlan.findMany({ where: { organizationId: org } }),
      this.prisma.commissionGoal.findMany({ where: { organizationId: org, month } }),
      this.salesByVendor(org, from, to),
    ]);
    const goalBy = new Map(goals.map((g) => [g.vendedor, Number(g.goalAmount)]));
    const salesBy = new Map(sales.map((s) => [s.vendedor, s]));
    const names = new Set<string>([
      ...plans.filter((p) => p.active).map((p) => p.vendedor),
      ...sales.map((s) => s.vendedor),
    ]);

    const rows = [...names].map((vendedor) => {
      const plan = plans.find((p) => p.vendedor === vendedor) ?? null;
      const s = salesBy.get(vendedor) ?? { vendedor, pedidos: 0, bruto: 0, produtos: 0, frete: 0, base: 0, pendentes: 0 };
      const vendas = s.base;
      const metaMes = goalBy.get(vendedor);
      const rule = plan
        ? {
            fixedAmount: Number(plan.fixedAmount),
            goalAmount: metaMes ?? Number(plan.goalAmount),
            percent: Number(plan.percent),
            percentBase: plan.percentBase as PercentBase,
            keepFixed: plan.keepFixed,
          }
        : null;
      const calc = rule && plan!.active ? calcCommission(vendas, rule) : null;
      return {
        vendedor,
        planId: plan?.id ?? null,
        temRegra: !!plan,
        regraAtiva: plan?.active ?? false,
        metaDoMes: metaMes ?? null,
        pedidos: s.pedidos,
        bruto: r2(s.bruto),
        produtos: r2(s.produtos),
        frete: r2(s.frete),
        vendas: r2(vendas),
        fretePendente: s.pendentes,
        regra: rule,
        calc,
      };
    });
    rows.sort((a, b) => b.vendas - a.vendas);

    const sum = (f: (r: (typeof rows)[number]) => number) => r2(rows.reduce((a, r) => a + f(r), 0));
    return {
      month,
      from,
      to,
      rows,
      totais: {
        pedidos: rows.reduce((a, r) => a + r.pedidos, 0),
        bruto: sum((r) => r.bruto),
        produtos: sum((r) => r.produtos),
        frete: sum((r) => r.frete),
        vendas: sum((r) => r.vendas),
        comissao: sum((r) => r.calc?.total ?? 0),
        fretePendente: rows.reduce((a, r) => a + r.fretePendente, 0),
      },
    };
  }

  /** Lê do Tiny o frete dos pedidos do mês ainda não apurados (até 120 por vez). */
  async refreshFreight(org: string, month: string) {
    const { from, to } = this.range(month);
    return this.tiny.enrichFreight(org, { limit: 120, from, to });
  }

  async exportXlsx(org: string, month: string): Promise<Buffer> {
    const rep = await this.report(org, month);
    const { from, to } = this.range(month);
    const pct = (n: number | null | undefined) =>
      n == null ? '—' : `${(n * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;

    const resumo: Cell[][] = [
      [H(`Comissões — ${month}`)],
      [S('Base da comissão'), S('Produtos (valor líquido, após desconto) − Frete, dos pedidos de venda direta do Tiny')],
      [S('Gerado em'), S(new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }))],
      [],
      ['Vendedor', 'Pedidos', 'Total dos pedidos (R$)', 'Produtos líquidos (R$)', 'Frete (R$)', 'Base da comissão (R$)', 'Meta (R$)', 'Atingimento',
       'Fixo (R$)', '% após meta', 'Base do %', 'Variável (R$)', 'Comissão total (R$)', 'Pedidos a apurar no Tiny'].map(H),
    ];
    for (const r of rep.rows) {
      resumo.push([
        S(r.vendedor), N(r.pedidos), N(r.bruto), N(r.produtos), N(r.frete), N(r.vendas),
        r.calc ? N(r.calc.meta) : S(r.temRegra ? 'regra inativa' : 'sem regra'),
        S(r.calc ? pct(r.calc.atingimento) : ''),
        r.calc ? N(r.calc.fixo) : S(''),
        S(r.regra ? `${r.regra.percent}% sobre ${r.regra.percentBase === 'TOTAL' ? 'o total' : 'o excedente'}` : ''),
        r.calc ? N(r.calc.baseVariavel) : S(''),
        r.calc ? N(r.calc.variavel) : S(''),
        r.calc ? N(r.calc.total) : S(''),
        N(r.fretePendente),
      ]);
    }
    resumo.push([
      H('Total'), N(rep.totais.pedidos), N(rep.totais.bruto), N(rep.totais.produtos), N(rep.totais.frete), N(rep.totais.vendas),
      S(''), S(''), S(''), S(''), S(''), S(''), N(rep.totais.comissao), N(rep.totais.fretePendente),
    ]);

    const docs = await this.prisma.$queryRaw<any[]>`
      SELECT ${VEND_EXPR} AS vendedor, numero, data, situacao,
             cliente_nome AS cliente, valor::float8 AS valor,
             (${PRODUTOS})::float8 AS produtos, (${FRETE})::float8 AS frete, ${APURADO} AS apurado
      FROM tiny_documents
      WHERE ${this.salesWhere(org, from, to)}
      ORDER BY 1, data, numero`;
    const pedidos: Cell[][] = [
      ['Vendedor', 'Número', 'Data', 'Situação', 'Cliente', 'Total do pedido (R$)', 'Produtos líquidos (R$)', 'Frete (R$)', 'Base da comissão (R$)', 'Apurado no Tiny'].map(H),
    ];
    for (const d of docs) {
      const prod = Number(d.produtos ?? 0);
      const frete = Number(d.frete ?? 0);
      pedidos.push([
        S(d.vendedor), S(d.numero ?? ''),
        S(d.data ? new Date(d.data).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : ''),
        S(d.situacao ?? ''), S(d.cliente ?? ''),
        N(r2(d.valor ?? 0)), N(r2(prod)), N(r2(frete)), N(r2(Math.max(prod - frete, 0))), S(d.apurado ? 'sim' : 'não'),
      ]);
    }
    return buildXlsx([
      { name: 'Comissões', rows: resumo },
      { name: 'Pedidos', rows: pedidos },
    ]);
  }

  // ── internos ───────────────────────────────────────────────────────

  private range(month: string) {
    try {
      return monthRange(month);
    } catch {
      throw new BadRequestException('Mês inválido (use AAAA-MM)');
    }
  }

  private salesWhere(org: string, from: Date, to: Date): Prisma.Sql {
    return Prisma.sql`organization_id = ${org}
      AND kind = 'PEDIDO' AND is_marketplace = false
      AND natureza ILIKE '%venda%'
      AND COALESCE(situacao, '') <> ALL(${EXCLUIDOS}::text[])
      AND data >= (${from.toISOString()}::timestamptz AT TIME ZONE 'UTC')
      AND data <= (${to.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;
  }

  /**
   * Vendas do mês por vendedor. Base da comissão = PRODUTOS LÍQUIDOS − FRETE,
   * por pedido (mínimo 0). Pedido ainda não apurado no Tiny (ou cujo valor
   * mudou desde a leitura) entra pelo valor do pedido e conta em "pendentes".
   */
  private async salesByVendor(org: string, from: Date, to: Date): Promise<SalesRow[]> {
    const rows = await this.prisma.$queryRaw<any[]>`
      SELECT ${VEND_EXPR} AS vendedor,
             count(*)::int AS pedidos,
             COALESCE(sum(valor), 0)::float8 AS bruto,
             COALESCE(sum(${PRODUTOS}), 0)::float8 AS produtos,
             COALESCE(sum(${FRETE}), 0)::float8 AS frete,
             COALESCE(sum(GREATEST(${PRODUTOS} - ${FRETE}, 0)), 0)::float8 AS base,
             count(*) FILTER (WHERE NOT ${APURADO})::int AS pendentes
      FROM tiny_documents
      WHERE ${this.salesWhere(org, from, to)}
      GROUP BY 1`;
    return rows.map((r) => ({
      vendedor: r.vendedor,
      pedidos: r.pedidos,
      bruto: Number(r.bruto),
      produtos: Number(r.produtos),
      frete: Number(r.frete),
      base: Number(r.base),
      pendentes: r.pendentes,
    }));
  }

  private planOut(p: any) {
    return {
      id: p.id,
      vendedor: p.vendedor,
      userId: p.userId,
      active: p.active,
      fixedAmount: Number(p.fixedAmount),
      goalAmount: Number(p.goalAmount),
      percent: Number(p.percent),
      percentBase: p.percentBase as PercentBase,
      keepFixed: p.keepFixed,
      notes: p.notes,
      updatedAt: p.updatedAt,
    };
  }
}

function r2(n: number) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
