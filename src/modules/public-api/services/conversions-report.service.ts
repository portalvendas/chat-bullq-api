import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';

/**
 * Relatório de RESULTADO por campanha, lado CRM (ticket Fase 2 · E1).
 *
 * Uma linha por pedido e uma por orçamento do Tiny, com a origem do lead ligado
 * (canal, UTMs de primeiro toque, anúncio de WhatsApp) e o que foi enviado à
 * Meta. NÃO depende da atribuição da Meta e cobre o histórico inteiro.
 * Sem dados pessoais: só o id interno do contato (nada de nome, telefone, CPF
 * ou e-mail).
 *
 * Consumido pelo n8n (export diário para o Google Sheets) via
 * GET /api/v1/public/reports/conversions?from=2026-08-01 (chave pk_).
 *
 * Exemplo de linha:
 *   { tipo: "pedido", numero: "4512", data_documento: "2026-10-15",
 *     valor: 3490, situacao: "Aberta", eh_venda_efetiva: "s",
 *     contato_id: "cm…", metodo_ligacao: "cpf", data_primeiro_contato: "2026-10-10",
 *     canal_origem: "LP", utm_source: "facebook", utm_campaign: "1202…", …,
 *     ad_id_ctwa: "", ad_headline: "", tem_fbclid: "s", tem_fbc: "s",
 *     enviado_meta: "s", status_meta: "sent", action_source_meta: "website" }
 */

const PEDIDO_STATUS_EXCLUIDOS = ['Cancelada', 'Dados Incompletos', 'Removido'];
const EVENT_WINDOW_MS = 7 * 24 * 3600 * 1000;

interface RawRow {
  kind: string;
  numero: string | null;
  data: Date | null;
  valor: string | number | null;
  situacao: string | null;
  isMarketplace: boolean;
  natureza: string | null;
  contactId: string | null;
  matchedBy: string | null;
  matchManual: boolean;
  contactCreatedAt: Date | null;
  contactSource: string | null;
  cardSource: string | null;
  channelType: string | null;
  tracking: Record<string, any> | null;
  metaStatus: string | null;
  metaActionSource: string | null;
}

export interface ConversionReportRow {
  tipo: 'pedido' | 'orcamento';
  numero: string;
  data_documento: string;
  valor: number | null;
  situacao: string;
  eh_venda_efetiva: 's' | 'n' | '';
  contato_id: string;
  metodo_ligacao: string;
  data_primeiro_contato: string;
  canal_origem: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  utm_content: string;
  utm_term: string;
  utm_id: string;
  ad_id_ctwa: string;
  ad_headline: string;
  tem_fbclid: 's' | 'n';
  tem_fbc: 's' | 'n';
  enviado_meta: 's' | 'n';
  status_meta: string;
  action_source_meta: string;
}

export const CONVERSION_REPORT_COLUMNS: (keyof ConversionReportRow)[] = [
  'tipo', 'numero', 'data_documento', 'valor', 'situacao', 'eh_venda_efetiva',
  'contato_id', 'metodo_ligacao', 'data_primeiro_contato', 'canal_origem',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_id',
  'ad_id_ctwa', 'ad_headline', 'tem_fbclid', 'tem_fbc',
  'enviado_meta', 'status_meta', 'action_source_meta',
];

@Injectable()
export class ConversionsReportService {
  private readonly logger = new Logger(ConversionsReportService.name);

  constructor(private readonly prisma: PrismaService) {}

  async build(
    organizationId: string,
    range: { from: Date; to: Date },
  ): Promise<{ from: string; to: string; total: number; rows: ConversionReportRow[] }> {
    const rows = await this.prisma.$queryRaw<RawRow[]>`
      SELECT
        d.kind                                AS kind,
        d.numero                              AS numero,
        d.data                                AS data,
        d.valor                               AS valor,
        d.situacao                            AS situacao,
        d.is_marketplace                      AS "isMarketplace",
        d.natureza                            AS natureza,
        d.contact_id                          AS "contactId",
        d.matched_by                          AS "matchedBy",
        d.match_manual                        AS "matchManual",
        ct.created_at                         AS "contactCreatedAt",
        ct.metadata->>'source'                AS "contactSource",
        fc.source                             AS "cardSource",
        fv.type                               AS "channelType",
        ct.metadata->'tracking'               AS tracking,
        ev.status                             AS "metaStatus",
        ev.action_source                      AS "metaActionSource"
      FROM tiny_documents d
      LEFT JOIN contacts ct ON ct.id = d.contact_id
      LEFT JOIN LATERAL (
        SELECT c2.metadata->>'source' AS source
        FROM cards c2
        WHERE c2.contact_id = d.contact_id
        ORDER BY c2.created_at ASC LIMIT 1
      ) fc ON d.contact_id IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT ch.type::text AS type
        FROM conversations cv JOIN channels ch ON ch.id = cv.channel_id
        WHERE cv.contact_id = d.contact_id
        ORDER BY cv.created_at ASC LIMIT 1
      ) fv ON d.contact_id IS NOT NULL
      LEFT JOIN LATERAL (
        SELECT e.status, e.action_source
        FROM meta_capi_events e
        WHERE e.tiny_document_id = d.id
        ORDER BY (e.status = 'sent') DESC, e.sent_at DESC LIMIT 1
      ) ev ON true
      WHERE d.organization_id = ${organizationId}
        AND d.data >= ${range.from}
        AND d.data <= ${range.to}
      ORDER BY d.data DESC, d.kind, d.numero
      LIMIT 50000`;

    const cfg = await this.prisma.metaCapiConfig.findUnique({ where: { organizationId } });
    const purchaseSit = ((cfg?.purchaseSituacoes as string[]) ?? []).map(norm);
    const atcSit = ((cfg?.addToCartSituacoes as string[]) ?? []).map(norm);

    const out = rows.map((r): ConversionReportRow => {
      const tr = (r.tracking && typeof r.tracking === 'object' ? r.tracking : {}) as Record<string, any>;
      const isPedido = r.kind === 'PEDIDO';
      const valor = r.valor == null ? null : Number(r.valor);
      const vendaEfetiva =
        !r.isMarketplace &&
        /venda/i.test(r.natureza ?? '') &&
        !PEDIDO_STATUS_EXCLUIDOS.includes(r.situacao ?? '');

      return {
        tipo: isPedido ? 'pedido' : 'orcamento',
        numero: r.numero ?? '',
        data_documento: ymd(r.data),
        valor: valor != null && Number.isFinite(valor) ? Math.round(valor * 100) / 100 : null,
        situacao: r.situacao ?? '',
        eh_venda_efetiva: isPedido ? (vendaEfetiva ? 's' : 'n') : '',
        contato_id: r.contactId ?? '',
        metodo_ligacao: metodoLigacao(r),
        data_primeiro_contato: ymd(r.contactCreatedAt),
        canal_origem: canalOrigem(r, tr),
        utm_source: str(tr.utm_source),
        utm_medium: str(tr.utm_medium),
        utm_campaign: str(tr.utm_campaign),
        utm_content: str(tr.utm_content),
        utm_term: str(tr.utm_term),
        utm_id: str(tr.utm_id),
        ad_id_ctwa: str(tr.ad_id),
        ad_headline: str(tr.ad_headline),
        tem_fbclid: tr.fbclid ? 's' : 'n',
        tem_fbc: tr.fbc || tr.fbclid ? 's' : 'n',
        enviado_meta: r.metaStatus === 'sent' ? 's' : 'n',
        status_meta: statusMeta(r, {
          enabled: !!cfg?.enabled,
          isPedido,
          vendaEfetiva,
          valor,
          purchaseSit,
          atcEnabled: !!cfg?.addToCartEnabled,
          atcSit,
        }),
        action_source_meta: r.metaStatus === 'sent' ? str(r.metaActionSource) : '',
      };
    });

    return { from: ymd(range.from), to: ymd(range.to), total: out.length, rows: out };
  }

  /** CSV (`;` como separador, padrão do Excel/Sheets em pt-BR). */
  toCsv(rows: ConversionReportRow[]): string {
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      return /[;"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [CONVERSION_REPORT_COLUMNS.join(';')];
    for (const r of rows) lines.push(CONVERSION_REPORT_COLUMNS.map((c) => esc(r[c])).join(';'));
    return lines.join('\n');
  }
}

function norm(s: string): string {
  return String(s ?? '').trim().toLowerCase();
}
function str(v: unknown): string {
  return v == null ? '' : String(v).trim();
}
function ymd(d: Date | null | undefined): string {
  return d ? new Date(d).toISOString().slice(0, 10) : '';
}

/** cpf / telefone / email / nome / tiny_contato / manual / sem_ligacao. */
function metodoLigacao(r: RawRow): string {
  if (!r.contactId) return 'sem_ligacao';
  if (r.matchManual) return 'manual';
  switch (r.matchedBy) {
    case 'cpf_cnpj': return 'cpf';
    case 'phone': return 'telefone';
    case 'email': return 'email';
    case 'name':
    case 'name_partial': return 'nome';
    case 'tiny_contato': return 'tiny_contato';
    default: return r.matchedBy ?? 'desconhecido';
  }
}

/** LP / Lead Ads / WhatsApp Oficial / Baileys / Z-API / Zappfy / Instagram / Marketplace / outro. */
function canalOrigem(r: RawRow, tr: Record<string, any>): string {
  if (!r.contactId) return '';
  const src = `${r.contactSource ?? ''} ${r.cardSource ?? ''}`.toLowerCase();
  if (/leadads/.test(src)) return 'Lead Ads';
  if (/(^|[^a-z])lp|landing/.test(src) || tr.page_url || tr.landing_url) return 'LP';
  switch (r.channelType) {
    case 'WHATSAPP_OFFICIAL': return 'WhatsApp Oficial';
    case 'WHATSAPP_BAILEYS': return 'Baileys';
    case 'WHATSAPP_ZAPI': return 'Z-API';
    case 'WHATSAPP_ZAPPFY': return 'Zappfy';
    case 'INSTAGRAM': return 'Instagram';
    case 'MERCADO_LIVRE':
    case 'SHOPEE': return 'Marketplace';
    default: return 'outro';
  }
}

/** sent / failed / filtrado_* / sem_valor / fora_da_janela_7d / capi_desligado / pendente. */
function statusMeta(
  r: RawRow,
  c: {
    enabled: boolean;
    isPedido: boolean;
    vendaEfetiva: boolean;
    valor: number | null;
    purchaseSit: string[];
    atcEnabled: boolean;
    atcSit: string[];
  },
): string {
  if (r.metaStatus === 'sent' || r.metaStatus === 'failed') return r.metaStatus;
  if (!c.enabled) return 'capi_desligado';
  const sit = norm(r.situacao ?? '');
  if (c.isPedido) {
    if (!c.vendaEfetiva) return 'filtrado_nao_e_venda';
    if (!c.purchaseSit.includes(sit)) return 'filtrado_situacao';
  } else {
    if (!c.atcEnabled) return 'capi_desligado';
    if (c.atcSit.length && !c.atcSit.includes(sit)) return 'filtrado_situacao';
  }
  if (!(c.valor != null && c.valor > 0)) return 'sem_valor';
  if (r.data && Date.now() - new Date(r.data).getTime() > EVENT_WINDOW_MS) return 'fora_da_janela_7d';
  return 'pendente';
}
