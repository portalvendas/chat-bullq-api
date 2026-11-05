import { Injectable } from '@nestjs/common';
import { TinyService } from './tiny.service';
import { buildXlsx, H, S, N } from '../dashboard/xlsx-lite.util';
import type { Cell } from '../dashboard/xlsx-lite.util';

export interface TinyReportFilters {
  from?: string;
  to?: string;
  /** '' / undefined = todos; '__sem__' = sem vendedor; senão o nome. */
  vendedor?: string;
  /** Só pedidos: sem | parcial | confere | excedente. */
  comprovante?: string;
}

const COMPROVANTE_LABEL: Record<string, string> = {
  sem: 'Sem comprovante',
  parcial: 'Parcial',
  confere: 'Comprovante OK',
  excedente: 'Excedente',
  na: '',
};

/**
 * RELATÓRIO de Pedidos & Propostas em .xlsx — exatamente o que a tela mostra,
 * com os MESMOS filtros (período, vendedor, comprovante) e as mesmas consultas
 * (summary + listDocuments), então os números batem com a tela.
 *
 * Abas:
 *  - Resumo:        filtros aplicados + cards (pedidos, propostas, ticket,
 *                   conversão, leads, sem resposta) com o período anterior.
 *  - Por vendedor:  a tabela "Por vendedor" com as mesmas fórmulas da tela.
 *  - Pedidos:       todos os pedidos do filtro (comprovante aplicado).
 *  - Propostas:     todas as propostas do filtro.
 */
@Injectable()
export class TinyReportService {
  constructor(private readonly tiny: TinyService) {}

  async build(organizationId: string, f: TinyReportFilters): Promise<Buffer> {
    const vendedor = f.vendedor || undefined;
    const [summary, pedidos, propostas] = await Promise.all([
      this.tiny.summary(organizationId, f.from, f.to, vendedor),
      this.allDocs(organizationId, 'PEDIDO', f, vendedor, f.comprovante || undefined),
      this.allDocs(organizationId, 'ORCAMENTO', f, vendedor, undefined),
    ]);

    return buildXlsx([
      { name: 'Resumo', rows: this.resumo(summary, f) },
      { name: 'Por vendedor', rows: this.porVendedor(summary) },
      { name: 'Pedidos', rows: this.docRows(pedidos, true) },
      { name: 'Propostas', rows: this.docRows(propostas, false) },
    ]);
  }

  /** Percorre todas as páginas do listDocuments (100 por vez). */
  private async allDocs(
    org: string,
    kind: 'PEDIDO' | 'ORCAMENTO',
    f: TinyReportFilters,
    vendedor?: string,
    comprovante?: string,
  ): Promise<any[]> {
    const out: any[] = [];
    for (let page = 1; page <= 200; page++) {
      const r = await this.tiny.listDocuments(org, kind, page, 100, f.from, f.to, vendedor, comprovante);
      out.push(...r.items);
      if (page >= r.pagination.totalPages) break;
    }
    return out;
  }

  private resumo(s: any, f: TinyReportFilters): Cell[][] {
    const ped = s.pedidos ?? { count: 0, total: 0 };
    const orc = s.orcamentos ?? { count: 0, total: 0 };
    const prev = s.previous ?? null;
    const ticket = ped.count > 0 ? ped.total / ped.count : 0;
    const conv = orc.count > 0 ? ped.count / orc.count : null;
    const pTicket = prev && prev.pedidos?.count > 0 ? prev.pedidos.total / prev.pedidos.count : null;
    const vendLabel =
      !f.vendedor ? 'Todos' : f.vendedor === '__sem__' ? 'Sem vendedor' : f.vendedor;
    const compLabel = f.comprovante ? COMPROVANTE_LABEL[f.comprovante] ?? f.comprovante : 'Todos';
    const rows: Cell[][] = [
      [H('Relatório de Pedidos & Propostas')],
      [S('Gerado em'), S(fmtDateTime(new Date()))],
      [S('Período'), S(f.from || f.to ? `${fmtDate(f.from)} a ${fmtDate(f.to)}` : 'Tudo')],
      [S('Vendedor'), S(vendLabel)],
      [S('Comprovante (pedidos)'), S(compLabel)],
      [],
      ['Indicador', 'Período', 'Período anterior'].map(H),
      [S('Pedidos (qtd)'), N(ped.count), prev ? N(prev.pedidos?.count) : S('')],
      [S('Pedidos (R$)'), N(round2(ped.total)), prev ? N(round2(prev.pedidos?.total ?? 0)) : S('')],
      [S('Propostas (qtd)'), N(orc.count), prev ? N(prev.orcamentos?.count) : S('')],
      [S('Propostas (R$)'), N(round2(orc.total)), prev ? N(round2(prev.orcamentos?.total ?? 0)) : S('')],
      [S('Ticket médio (R$)'), N(round2(ticket)), pTicket != null ? N(round2(pTicket)) : S('')],
      [S('Conversão propostas → pedidos'), S(pct(conv)), S('')],
      [S('Leads (pessoas únicas)'), N(s.leads?.count ?? 0), prev?.leads ? N(prev.leads.count) : S('')],
      [S('Leads por dia'), s.leads?.perDay != null ? N(s.leads.perDay) : S('—'), prev?.leads?.perDay != null ? N(prev.leads.perDay) : S('')],
      [S('Leads sem resposta'), N(s.leads?.noResponse ?? 0), S('')],
    ];
    if (f.comprovante) {
      rows.push([], [S('Obs.: o filtro de comprovante vale para a aba Pedidos; os cards seguem a tela.')]);
    }
    return rows;
  }

  private porVendedor(s: any): Cell[][] {
    const rows: Cell[][] = [
      ['Vendedor', 'Leads', 'Lead → Pedido', 'Pedidos', 'R$ pedidos', 'Propostas', 'R$ propostas', 'Conv.', 'Conv. R$', 'Ticket médio'].map(H),
    ];
    const tot = { leads: 0, ped: 0, pedR: 0, orc: 0, orcR: 0 };
    for (const v of s.porVendedor ?? []) {
      const leads = v.leadsCount ?? 0;
      rows.push([
        S(v.vendedor),
        N(leads),
        S(pct(leads > 0 ? v.pedidosCount / leads : null)),
        N(v.pedidosCount),
        N(round2(v.pedidosTotal)),
        N(v.propostasCount),
        N(round2(v.propostasTotal)),
        S(pct(v.propostasCount > 0 ? v.pedidosCount / v.propostasCount : null)),
        S(pct(v.propostasTotal > 0 ? v.pedidosTotal / v.propostasTotal : null)),
        N(round2(v.pedidosCount > 0 ? v.pedidosTotal / v.pedidosCount : 0)),
      ]);
      tot.leads += leads;
      tot.ped += v.pedidosCount;
      tot.pedR += v.pedidosTotal;
      tot.orc += v.propostasCount;
      tot.orcR += v.propostasTotal;
    }
    rows.push([
      H('Total'),
      N(tot.leads),
      S(pct(tot.leads > 0 ? tot.ped / tot.leads : null)),
      N(tot.ped),
      N(round2(tot.pedR)),
      N(tot.orc),
      N(round2(tot.orcR)),
      S(pct(tot.orc > 0 ? tot.ped / tot.orc : null)),
      S(pct(tot.orcR > 0 ? tot.pedR / tot.orcR : null)),
      N(round2(tot.ped > 0 ? tot.pedR / tot.ped : 0)),
    ]);
    return rows;
  }

  private docRows(items: any[], pedido: boolean): Cell[][] {
    const head = [
      'Número', 'Situação', 'Data', 'Cliente (Tiny)', 'Lead vinculado', 'Telefone',
      'Dias (orç. → últ. msg)', 'Vendedor', 'Valor (R$)',
      ...(pedido ? ['Comprovante', 'Qtd comprovantes', 'Soma comprovantes (R$)'] : []),
    ];
    const rows: Cell[][] = [head.map(H)];
    let total = 0;
    for (const d of items) {
      total += d.valor ?? 0;
      rows.push([
        S(d.numero ?? ''),
        S(d.situacao ?? ''),
        S(fmtDate(d.data)),
        S(d.clienteNome ?? ''),
        S(d.lead?.name ?? ''),
        S(d.lead?.phone ?? d.clienteTelefone ?? ''),
        d.diasOrcamentoUltimaMsg != null ? N(d.diasOrcamentoUltimaMsg) : S(''),
        S(d.vendedor ?? 'Sem vendedor'),
        N(round2(d.valor ?? 0)),
        ...(pedido
          ? [
              S(COMPROVANTE_LABEL[d.comprovanteStatus] ?? d.comprovanteStatus ?? ''),
              N(d.comprovanteCount ?? 0),
              N(round2(d.comprovanteSoma ?? 0)),
            ]
          : []),
      ]);
    }
    rows.push([H('Total'), S(''), S(''), S(''), S(`${items.length} documento(s)`), S(''), S(''), S(''), N(round2(total))]);
    return rows;
  }
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}
function pct(r: number | null): string {
  return r == null ? '—' : `${(r * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}
/** Data no fuso de Brasília (dd/mm/aaaa). */
function fmtDate(v?: string | Date | null): string {
  if (!v) return '';
  const d = new Date(v);
  if (isNaN(d.getTime())) return '';
  return d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
function fmtDateTime(d: Date): string {
  return d.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
