import { Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { PrismaService } from '../../database/prisma.service';
import { canonicalPhone } from '../../common/phone.util';

export type GoogleAudience = 'compradores' | 'qualificados' | 'frios' | 'base';

export const GOOGLE_AUDIENCES: GoogleAudience[] = ['compradores', 'qualificados', 'frios', 'base'];

/** Listas EXCLUSIVAS entre si (prioridade nesta ordem). 'base' é a soma de tudo. */
const EXCLUSIVE: GoogleAudience[] = ['compradores', 'qualificados', 'frios'];

/** Situações do Tiny que NÃO são venda efetiva. */
const NAO_VENDA = ['Cancelada', 'Dados Incompletos', 'Removido'];

interface Row {
  contactId: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  metadata: any;
  docEmail: string | null;
  docNome: string | null;
  docRaw: any;
}

/**
 * LISTAS DE PÚBLICO PARA O GOOGLE ADS (Customer Match) — todos os canais
 * (Meta, Google, orgânico, WhatsApp). NÃO são conversões: servem para o Google
 * saber quem já é cliente (meta "aquisição de novos clientes" da PMax) e achar
 * gente parecida com os leads bons.
 *
 * Listas (cada pessoa cai em UMA só, nesta ordem):
 *  - compradores:  pedido de VENDA DIRETA no Tiny (sem marketplace, natureza
 *                  "Venda", não cancelado) nos últimos 540 dias (validade máxima
 *                  de membro no Customer Match).
 *  - qualificados: sem compra; orçamento no Tiny ou lead score ≥ 60 nos
 *                  últimos 180 dias.
 *  - frios:        sem compra e não qualificado; card PERDIDO nos últimos 180 dias.
 *  - base:         BASE COMPLETA — todo contato do CRM (leads de todos os canais,
 *                  clientes, conversas do WhatsApp/Instagram). Não exclusiva: é
 *                  a lista grande, para passar do mínimo de 1.000 reconhecidos
 *                  do Google (veicular, excluir quem já é da base, sinal da PMax).
 *                  Fica de fora: grupo de WhatsApp e número inválido.
 *
 * Fora sempre: contato excluído e quem pediu para não receber disparos
 * (opt-out). Sem e-mail e sem telefone → não entra (nada para casar).
 *
 * Formato (CSV "hashed" do Google Ads): Email, Phone, First Name, Last Name,
 * Country, Zip. E-mail/telefone/nome em SHA-256 normalizados (minúsculas, sem
 * espaços nas pontas; telefone E.164 "+55…"); País e CEP em texto (o Google
 * exige assim). Nome só vai junto com CEP (o Google só usa nome+país+CEP).
 *
 *   Email,Phone,First Name,Last Name,Country,Zip
 *   9f86d0…,a665a4…,2c26b4…,fcde2b…,BR,01310-100
 */
@Injectable()
export class GoogleAudiencesService {
  constructor(private readonly prisma: PrismaService) {}

  async buildCsv(organizationId: string, lista: GoogleAudience): Promise<{ csv: string; rows: number }> {
    const rows = await this.query(organizationId, lista);
    // A mesma PESSOA pode estar em 2 contatos (ex.: mesmo e-mail com outro
    // telefone). Exclui das listas de menor prioridade quem já tem e-mail ou
    // telefone numa lista acima (compradores > qualificados > frios).
    const above = lista === 'base' ? [] : EXCLUSIVE.slice(0, EXCLUSIVE.indexOf(lista));
    const taken = new Set<string>();
    for (const l of above) {
      for (const r of await this.query(organizationId, l)) {
        const e = normEmail(r.email ?? r.docEmail);
        const p = normPhone(r.phone);
        if (e) taken.add(`e:${e}`);
        if (p) taken.add(`p:${p}`);
      }
    }
    const seen = new Set<string>();
    const lines = ['Email,Phone,First Name,Last Name,Country,Zip'];
    for (const r of rows) {
      const email = normEmail(r.email ?? r.docEmail);
      const phone = normPhone(r.phone);
      if (!email && !phone) continue;
      if ((email && taken.has(`e:${email}`)) || (phone && taken.has(`p:${phone}`))) continue;
      const key = `${email}|${phone}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const zip = normCep(r.metadata?.endereco?.cep ?? cepFromRaw(r.docRaw));
      const { first, last } = splitName(r.name || r.docNome);
      const withName = !!(zip && first && last);
      lines.push(
        [
          email ? sha256(email) : '',
          phone ? sha256(phone) : '',
          withName ? sha256(first!) : '',
          withName ? sha256(last!) : '',
          'BR',
          zip,
        ].join(','),
      );
    }
    return { csv: lines.join('\n') + '\n', rows: lines.length - 1 };
  }

  private query(org: string, lista: GoogleAudience): Promise<Row[]> {
    // CTEs compartilhadas: compradores e qualificados (para as exclusões).
    return this.prisma.$queryRawUnsafe<Row[]>(
      `
      WITH buyers AS (
        SELECT DISTINCT d.contact_id FROM tiny_documents d
        WHERE d.organization_id = $1 AND d.kind = 'PEDIDO' AND d.contact_id IS NOT NULL
          AND d.is_marketplace = false AND d.natureza ILIKE '%venda%'
          AND COALESCE(d.situacao, '') <> ALL($2::text[])
          AND d.data >= now() - interval '540 days'
      ),
      qualified AS (
        SELECT DISTINCT d.contact_id FROM tiny_documents d
        WHERE d.organization_id = $1 AND d.kind = 'ORCAMENTO' AND d.contact_id IS NOT NULL
          AND d.data >= now() - interval '180 days'
        UNION
        SELECT DISTINCT k.contact_id FROM cards k
        WHERE k.organization_id = $1 AND k.contact_id IS NOT NULL
          AND k.created_at >= now() - interval '180 days'
          AND (k.metadata->>'leadScore') ~ '^[0-9]+(\\.[0-9]+)?$'
          AND (k.metadata->>'leadScore')::numeric >= 60
      ),
      cold AS (
        SELECT DISTINCT k.contact_id FROM cards k
        WHERE k.organization_id = $1 AND k.contact_id IS NOT NULL
          AND k.status = 'LOST' AND COALESCE(k.closed_at, k.updated_at) >= now() - interval '180 days'
      ),
      target AS (
        ${
          lista === 'compradores'
            ? `SELECT contact_id FROM buyers`
            : lista === 'qualificados'
              ? `SELECT contact_id FROM qualified EXCEPT SELECT contact_id FROM buyers`
              : lista === 'frios'
                ? `SELECT contact_id FROM cold EXCEPT SELECT contact_id FROM buyers EXCEPT SELECT contact_id FROM qualified`
                : `SELECT c.id AS contact_id FROM contacts c
                   WHERE c.organization_id = $1
                     AND (c.phone IS NOT NULL OR c.email IS NOT NULL)
                     -- contato que só existe como GRUPO de WhatsApp não é pessoa
                     AND NOT EXISTS (SELECT 1 FROM conversations g
                                     WHERE g.contact_id = c.id AND g.is_group = true)`
        }
      )
      SELECT ct.id AS "contactId", ct.name, ct.phone, ct.email, ct.metadata,
             doc.cliente_email AS "docEmail", doc.cliente_nome AS "docNome", doc.raw AS "docRaw"
      FROM target t
      JOIN contacts ct ON ct.id = t.contact_id
      LEFT JOIN LATERAL (
        SELECT d.cliente_email, d.cliente_nome, d.raw FROM tiny_documents d
        WHERE d.contact_id = ct.id ORDER BY d.data DESC NULLS LAST LIMIT 1
      ) doc ON true
      WHERE ct.organization_id = $1
        AND ct.deleted_at IS NULL
        AND ct.broadcast_opted_out_at IS NULL
      ORDER BY ct.id`,
      org,
      NAO_VENDA,
    );
  }
}

// ── normalização (padrão do Google Ads) ────────────────────────────────

function sha256(v: string): string {
  return crypto.createHash('sha256').update(v, 'utf8').digest('hex');
}

function normEmail(v?: string | null): string {
  const s = String(v ?? '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : '';
}

/** E.164: +55DDDNUMERO (aplica a regra do 9º dígito). */
function normPhone(v?: string | null): string {
  const c = canonicalPhone(v);
  if (!c) return '';
  let d = c.replace(/\D/g, '');
  if (d.length === 10 || d.length === 11) d = '55' + d;
  // E.164 tem no máximo 15 dígitos (ids de grupo/lid do WhatsApp passam disso).
  return d.length >= 12 && d.length <= 15 ? '+' + d : '';
}

function normCep(v?: string | null): string {
  const d = String(v ?? '').replace(/\D/g, '');
  return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : '';
}

function cepFromRaw(raw: any): string | null {
  if (!raw || typeof raw !== 'object') return null;
  const cli = raw.cliente ?? {};
  for (const e of [cli.endereco, raw.endereco, cli.enderecoEntrega, raw.enderecoEntrega]) {
    if (e && typeof e === 'object' && e.cep) return String(e.cep);
  }
  return null;
}

function splitName(full?: string | null): { first?: string; last?: string } {
  const parts = String(full ?? '')
    .trim()
    .toLowerCase()
    .replace(/[0-9]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length < 2) return { first: parts[0] };
  return { first: parts[0], last: parts.slice(1).join(' ') };
}
