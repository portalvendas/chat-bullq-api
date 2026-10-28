import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { humanOutboundSql, waitingConversationsSql } from '../../common/waiting-reply.sql';

/**
 * CHECAGENS DO PROCESSO COMERCIAL — o que faz perder lead ou derruba a
 * performance da vendedora. 100% SQL (sem IA), rodam a cada auditoria.
 *
 * | Tipo                    | Quando acusa                                                        |
 * |-------------------------|---------------------------------------------------------------------|
 * | AGUARDANDO_RESPOSTA     | cliente escreveu e está há +15 min sem resposta HUMANA (regra única) |
 * | LEAD_NOVO_SEM_CONTATO   | card dos últimos 7 dias, +15 min, sem NENHUMA msg humana pro contato |
 * | ORCAMENTO_SEM_FOLLOWUP  | orçamento Tiny (30d) sem pedido e sem contato humano há +3 dias      |
 * | CARD_SEM_CONVERSA       | card aberto (30d) cujo contato não tem conversa (só formulário)      |
 * | CARD_PARADO             | sem mensagem/movimento além do prazo da etapa (padrão 7 dias)        |
 * | CARD_SEM_VENDEDOR       | card aberto (30d) sem vendedora (nem no card, nem na conversa)       |
 * | CONVERSA_SEM_CARD       | cliente falou nos últimos 7 dias e não tem card aberto (fora do funil)|
 * | VENDEDOR_DIVERGENTE     | card com uma vendedora e a conversa do lead com outra                |
 * | LEAD_DUPLICADO          | mesma pessoa (telefone) com mais de um card aberto                   |
 *
 * Funis de marketplace (ML/Shopee) ficam de fora. Um mesmo card recebe só o
 * achado de AÇÃO mais importante (ordem da tabela, até CARD_PARADO); sem
 * vendedor / divergente / duplicado são independentes.
 */
export type FindingType =
  | 'AGUARDANDO_RESPOSTA'
  | 'LEAD_NOVO_SEM_CONTATO'
  | 'ORCAMENTO_SEM_FOLLOWUP'
  | 'CARD_SEM_CONVERSA'
  | 'CARD_PARADO'
  | 'CARD_SEM_VENDEDOR'
  | 'CONVERSA_SEM_CARD'
  | 'VENDEDOR_DIVERGENTE'
  | 'LEAD_DUPLICADO';

export interface Finding {
  type: FindingType;
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  cardId: string | null;
  conversationId: string | null;
  contactId: string | null;
  ownerUserId: string | null;
  minutes: number | null;
  details: Record<string, unknown>;
}

/** Ordem de prioridade dos achados de AÇÃO (1 por card). */
const ACTION_PRIORITY: FindingType[] = [
  'AGUARDANDO_RESPOSTA',
  'LEAD_NOVO_SEM_CONTATO',
  'ORCAMENTO_SEM_FOLLOWUP',
  'CARD_SEM_CONVERSA',
  'CARD_PARADO',
];

const NOW = Prisma.raw(`(now() AT TIME ZONE 'UTC')`);
const MARKETPLACE_CHANNELS = Prisma.raw(`('MERCADO_LIVRE','SHOPEE')`);
const PEDIDO_EXCLUIDOS = Prisma.raw(`('Cancelada','Dados Incompletos','Removido')`);

/** Vendedora efetiva do card `k`: a do card; sem, a da conversa do contato. */
const OWNER_OF_K = Prisma.raw(`COALESCE(k.assigned_to_id, (
  SELECT cv.assigned_to_id FROM conversations cv
  WHERE cv.contact_id = k.contact_id AND cv.organization_id = k.organization_id
    AND cv.assigned_to_id IS NOT NULL
  ORDER BY (cv.id = k.conversation_id) DESC, cv.last_message_at DESC NULLS LAST
  LIMIT 1))`);

/**
 * Cards ABERTOS de lead (alias `k`): funil ativo, etapa normal, fora de
 * marketplace. Subconsulta — o chamador segue com `WHERE ...`/JOINs normais.
 */
const OPEN_LEAD_CARDS = (org: string) => Prisma.sql`(
  SELECT k.*, st.name AS stage_name, st.inactivity_minutes AS stage_inact,
         p.name AS pipeline_name, p.inactivity_minutes AS pipeline_inact
  FROM cards k
  JOIN pipelines p ON p.id = k.pipeline_id AND p.archived = false
  JOIN pipeline_stages st ON st.id = k.stage_id AND st.type = 'NORMAL'
  WHERE k.organization_id = ${org}
    AND k.status = 'OPEN'
    AND COALESCE(k.metadata->>'source', '') <> 'marketplace-sync'
) k`;

type Row = {
  cardId: string | null;
  conversationId: string | null;
  contactId: string | null;
  ownerUserId: string | null;
  minutes: number | null;
  details: Record<string, unknown> | null;
  sev?: string | null;
};

@Injectable()
export class FunnelChecksService {
  private readonly logger = new Logger(FunnelChecksService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Roda todas as checagens; uma que falhar não derruba as outras. */
  async run(organizationId: string): Promise<Finding[]> {
    const checks: [FindingType, (org: string) => Promise<Row[]>, Finding['severity']][] = [
      ['AGUARDANDO_RESPOSTA', (o) => this.waitingReply(o), 'HIGH'],
      ['LEAD_NOVO_SEM_CONTATO', (o) => this.newLeadNoContact(o), 'HIGH'],
      ['ORCAMENTO_SEM_FOLLOWUP', (o) => this.quoteNoFollowUp(o), 'HIGH'],
      ['CARD_SEM_CONVERSA', (o) => this.cardNoConversation(o), 'MEDIUM'],
      ['CARD_PARADO', (o) => this.cardStalled(o), 'MEDIUM'],
      ['CARD_SEM_VENDEDOR', (o) => this.cardNoSeller(o), 'HIGH'],
      ['CONVERSA_SEM_CARD', (o) => this.conversationNoCard(o), 'MEDIUM'],
      ['VENDEDOR_DIVERGENTE', (o) => this.sellerMismatch(o), 'LOW'],
      ['LEAD_DUPLICADO', (o) => this.duplicates(o), 'LOW'],
    ];
    const all: Finding[] = [];
    for (const [type, fn, sev] of checks) {
      try {
        const rows = await fn(organizationId);
        for (const r of rows) {
          all.push({
            type,
            severity: (r.sev as Finding['severity']) || sev,
            cardId: r.cardId,
            conversationId: r.conversationId,
            contactId: r.contactId,
            ownerUserId: r.ownerUserId,
            minutes: r.minutes != null ? Math.round(Number(r.minutes)) : null,
            details: r.details ?? {},
          });
        }
      } catch (err: any) {
        this.logger.warn(`checagem ${type} falhou (org=${organizationId}): ${err?.message ?? err}`);
      }
    }
    return this.dedupeActions(all);
  }

  /** 1 achado de AÇÃO por card (o mais prioritário); os demais tipos passam. */
  dedupeActions(all: Finding[]): Finding[] {
    const best = new Map<string, Finding>();
    const rest: Finding[] = [];
    for (const f of all) {
      const prio = ACTION_PRIORITY.indexOf(f.type);
      const key = f.cardId ?? (f.contactId ? `contact:${f.contactId}` : null);
      if (prio < 0 || !key) {
        rest.push(f);
        continue;
      }
      const cur = best.get(key);
      if (!cur || prio < ACTION_PRIORITY.indexOf(cur.type)) best.set(key, f);
    }
    return [...best.values(), ...rest];
  }

  // ── Checagens ──────────────────────────────────────────────────────

  private waitingReply(org: string) {
    // PÓS-VENDA (sem card aberto e já comprou: card GANHO ou pedido Tiny em
    // 120d) continua aparecendo — cliente esperando é cliente esperando —, mas
    // como ATENÇÃO e marcado, pra não se misturar com lead em risco.
    return this.prisma.$queryRaw<Row[]>`
      SELECT
        COALESCE(
          (SELECT k.id FROM cards k WHERE k.contact_id = w."contactId" AND k.organization_id = ${org}
             AND k.status = 'OPEN' ORDER BY k.created_at DESC LIMIT 1),
          (SELECT k.id FROM cards k WHERE k.contact_id = w."contactId" AND k.organization_id = ${org}
             ORDER BY k.created_at DESC LIMIT 1)) AS "cardId",
        CASE WHEN pv.pos_venda THEN 'MEDIUM' ELSE 'HIGH' END AS sev,
        w."conversationId", w."contactId",
        COALESCE(w."assignedToId", (SELECT k.assigned_to_id FROM cards k
           WHERE k.contact_id = w."contactId" AND k.organization_id = ${org}
             AND k.status = 'OPEN' AND k.assigned_to_id IS NOT NULL
           ORDER BY k.created_at DESC LIMIT 1)) AS "ownerUserId",
        EXTRACT(EPOCH FROM (${NOW} - w."waitingSince")) / 60 AS minutes,
        jsonb_build_object('kind', w.kind, 'posVenda', pv.pos_venda) AS details
      FROM (${waitingConversationsSql(Prisma.sql`
        c.organization_id = ${org}
        AND c.status <> 'CLOSED' AND c.is_archived = false
        AND c.last_message_at >= ${NOW} - interval '7 days'
        AND c.channel_id NOT IN (SELECT id FROM channels WHERE type::text IN ${MARKETPLACE_CHANNELS})`)}) w
      CROSS JOIN LATERAL (
        SELECT NOT EXISTS (SELECT 1 FROM cards k WHERE k.contact_id = w."contactId" AND k.status = 'OPEN')
           AND (EXISTS (SELECT 1 FROM cards k WHERE k.contact_id = w."contactId" AND k.status = 'WON'
                          AND k.closed_at >= ${NOW} - interval '120 days')
                OR EXISTS (SELECT 1 FROM tiny_documents d WHERE d.contact_id = w."contactId" AND d.kind = 'PEDIDO'
                          AND d.data >= ${NOW} - interval '120 days')) AS pos_venda
      ) pv
      WHERE w."waitingSince" < ${NOW} - interval '15 minutes'`;
  }

  private newLeadNoContact(org: string) {
    const human = humanOutboundSql('m');
    return this.prisma.$queryRaw<Row[]>`
      SELECT k.id AS "cardId", k.conversation_id AS "conversationId", k.contact_id AS "contactId",
             ${OWNER_OF_K} AS "ownerUserId",
             EXTRACT(EPOCH FROM (${NOW} - k.created_at)) / 60 AS minutes,
             CASE WHEN x.any_out THEN 'MEDIUM' ELSE 'HIGH' END AS sev,
             jsonb_build_object('soRobo', x.any_out, 'temConversa', x.has_conv,
                                'origem', COALESCE(k.metadata->>'source', 'whatsapp/manual')) AS details
      FROM ${OPEN_LEAD_CARDS(org)}
      CROSS JOIN LATERAL (
        SELECT EXISTS (SELECT 1 FROM conversations cv JOIN messages m ON m.conversation_id = cv.id
                       WHERE cv.contact_id = k.contact_id AND m.direction = 'OUTBOUND') AS any_out,
               EXISTS (SELECT 1 FROM conversations cv WHERE cv.contact_id = k.contact_id) AS has_conv
      ) x
      WHERE k.contact_id IS NOT NULL
        AND k.created_at >= ${NOW} - interval '7 days'
        AND k.created_at < ${NOW} - interval '15 minutes'
        AND NOT EXISTS (
          SELECT 1 FROM conversations cv JOIN messages m ON m.conversation_id = cv.id
          WHERE cv.contact_id = k.contact_id AND ${human})`;
  }

  private quoteNoFollowUp(org: string) {
    const human = humanOutboundSql('m');
    return this.prisma.$queryRaw<Row[]>`
      WITH q AS (
        SELECT DISTINCT ON (d.contact_id) d.contact_id, d.numero, d.valor, d.data
        FROM tiny_documents d
        WHERE d.organization_id = ${org} AND d.kind = 'ORCAMENTO' AND d.contact_id IS NOT NULL
          AND d.data >= ${NOW} - interval '30 days'
          AND d.data < ${NOW} - interval '3 days'
        ORDER BY d.contact_id, d.data DESC
      )
      SELECT
        (SELECT k.id FROM cards k WHERE k.contact_id = q.contact_id AND k.organization_id = ${org}
           AND k.status = 'OPEN' ORDER BY k.created_at DESC LIMIT 1) AS "cardId",
        (SELECT cv.id FROM conversations cv WHERE cv.contact_id = q.contact_id
           ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 1) AS "conversationId",
        q.contact_id AS "contactId",
        COALESCE(
          (SELECT k.assigned_to_id FROM cards k WHERE k.contact_id = q.contact_id AND k.organization_id = ${org}
             AND k.status = 'OPEN' AND k.assigned_to_id IS NOT NULL ORDER BY k.created_at DESC LIMIT 1),
          (SELECT cv.assigned_to_id FROM conversations cv WHERE cv.contact_id = q.contact_id
             AND cv.assigned_to_id IS NOT NULL ORDER BY cv.last_message_at DESC NULLS LAST LIMIT 1)
        ) AS "ownerUserId",
        EXTRACT(EPOCH FROM (${NOW} - GREATEST(q.data, COALESCE(h.last_human, q.data)))) / 60 AS minutes,
        jsonb_build_object('orcamento', q.numero, 'valor', q.valor, 'data', q.data) AS details
      FROM q
      CROSS JOIN LATERAL (
        SELECT MAX(m.created_at) AS last_human
        FROM conversations cv JOIN messages m ON m.conversation_id = cv.id
        WHERE cv.contact_id = q.contact_id AND ${human}
      ) h
      WHERE NOT EXISTS (
          SELECT 1 FROM tiny_documents p
          WHERE p.organization_id = ${org} AND p.kind = 'PEDIDO' AND p.contact_id = q.contact_id
            AND p.data >= q.data
            AND COALESCE(p.situacao, '') NOT IN ${PEDIDO_EXCLUIDOS}
            AND p.is_marketplace IS NOT TRUE
            AND COALESCE(p.natureza, '') ILIKE '%venda%')
        AND (h.last_human IS NULL OR h.last_human < ${NOW} - interval '3 days')
        -- lead já dado como perdido (sem card aberto e com card perdido) não cobra follow-up
        AND (EXISTS (SELECT 1 FROM cards k WHERE k.contact_id = q.contact_id AND k.status = 'OPEN')
             OR NOT EXISTS (SELECT 1 FROM cards k WHERE k.contact_id = q.contact_id AND k.status = 'LOST'))`;
  }

  private cardNoConversation(org: string) {
    return this.prisma.$queryRaw<Row[]>`
      SELECT k.id AS "cardId", NULL::text AS "conversationId", k.contact_id AS "contactId",
             ${OWNER_OF_K} AS "ownerUserId",
             EXTRACT(EPOCH FROM (${NOW} - k.created_at)) / 60 AS minutes,
             jsonb_build_object('origem', COALESCE(k.metadata->>'source', 'manual')) AS details
      FROM ${OPEN_LEAD_CARDS(org)}
      WHERE k.created_at >= ${NOW} - interval '30 days'
        AND k.created_at < ${NOW} - interval '15 minutes'
        AND EXISTS (SELECT 1 FROM contacts ct WHERE ct.id = k.contact_id AND ct.phone IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM conversations cv WHERE cv.contact_id = k.contact_id)`;
  }

  private cardStalled(org: string) {
    return this.prisma.$queryRaw<Row[]>`
      SELECT t.*, CASE WHEN t.minutes >= t.limite * 3 THEN 'HIGH' ELSE 'MEDIUM' END AS sev FROM (
        SELECT k.id AS "cardId", k.conversation_id AS "conversationId", k.contact_id AS "contactId",
               ${OWNER_OF_K} AS "ownerUserId",
               EXTRACT(EPOCH FROM (${NOW} - GREATEST(
                 k.created_at,
                 COALESCE((SELECT MAX(cv.last_message_at) FROM conversations cv WHERE cv.contact_id = k.contact_id), k.created_at),
                 COALESCE((SELECT MAX(e.created_at) FROM card_events e WHERE e.card_id = k.id), k.created_at)
               ))) / 60 AS minutes,
               COALESCE(k.stage_inact, k.pipeline_inact, 10080) AS limite,
               jsonb_build_object('etapa', k.stage_name, 'limiteMin', COALESCE(k.stage_inact, k.pipeline_inact, 10080)) AS details
        FROM ${OPEN_LEAD_CARDS(org)}
      ) t
      WHERE t.minutes >= t.limite
      ORDER BY t.minutes DESC
      LIMIT 2000`;
  }

  private cardNoSeller(org: string) {
    return this.prisma.$queryRaw<Row[]>`
      SELECT * FROM (
        SELECT k.id AS "cardId", k.conversation_id AS "conversationId", k.contact_id AS "contactId",
               ${OWNER_OF_K} AS "ownerUserId",
               EXTRACT(EPOCH FROM (${NOW} - k.created_at)) / 60 AS minutes,
               jsonb_build_object('funil', k.pipeline_name, 'etapa', k.stage_name) AS details
        FROM ${OPEN_LEAD_CARDS(org)}
        WHERE k.created_at >= ${NOW} - interval '30 days'
      ) t
      WHERE t."ownerUserId" IS NULL`;
  }

  private conversationNoCard(org: string) {
    return this.prisma.$queryRaw<Row[]>`
      SELECT NULL::text AS "cardId", c.id AS "conversationId", c.contact_id AS "contactId",
             c.assigned_to_id AS "ownerUserId",
             EXTRACT(EPOCH FROM (${NOW} - li.created_at)) / 60 AS minutes,
             jsonb_build_object('canal', ch.name) AS details
      FROM conversations c
      JOIN channels ch ON ch.id = c.channel_id AND ch.deleted_at IS NULL
        AND ch.type::text NOT IN ${MARKETPLACE_CHANNELS}
      JOIN LATERAL (
        SELECT m.created_at FROM messages m
        WHERE m.conversation_id = c.id AND m.direction = 'INBOUND'
        ORDER BY m.created_at DESC LIMIT 1
      ) li ON true
      WHERE c.organization_id = ${org}
        AND c.is_group = false AND c.deleted_at IS NULL
        AND li.created_at >= ${NOW} - interval '7 days'
        AND NOT EXISTS (SELECT 1 FROM cards k WHERE k.contact_id = c.contact_id AND k.status = 'OPEN')
        -- cliente que já comprou (pós-venda) não é lead fora do funil
        AND NOT EXISTS (SELECT 1 FROM cards k WHERE k.contact_id = c.contact_id AND k.status = 'WON'
                          AND k.closed_at >= ${NOW} - interval '120 days')
        AND NOT EXISTS (SELECT 1 FROM tiny_documents d WHERE d.contact_id = c.contact_id AND d.kind = 'PEDIDO'
                          AND d.data >= ${NOW} - interval '120 days')`;
  }

  private sellerMismatch(org: string) {
    return this.prisma.$queryRaw<Row[]>`
      SELECT k.id AS "cardId", cv.id AS "conversationId", k.contact_id AS "contactId",
             k.assigned_to_id AS "ownerUserId", NULL::int AS minutes,
             jsonb_build_object('vendedoraCard', uk.name, 'vendedoraConversa', uc.name) AS details
      FROM ${OPEN_LEAD_CARDS(org)}
      JOIN conversations cv ON cv.contact_id = k.contact_id
        AND cv.status <> 'CLOSED' AND cv.assigned_to_id IS NOT NULL
        AND cv.assigned_to_id <> k.assigned_to_id
        AND (cv.id = k.conversation_id OR k.conversation_id IS NULL)
      LEFT JOIN users uk ON uk.id = k.assigned_to_id
      LEFT JOIN users uc ON uc.id = cv.assigned_to_id
      WHERE k.assigned_to_id IS NOT NULL`;
  }

  private duplicates(org: string) {
    return this.prisma.$queryRaw<Row[]>`
      SELECT DISTINCT ON (g.pessoa)
             g.id AS "cardId", g.conversation_id AS "conversationId", g.contact_id AS "contactId",
             g.owner AS "ownerUserId", NULL::int AS minutes,
             jsonb_build_object('cardsAbertos', g.n) AS details
      FROM (
        SELECT k.id, k.conversation_id, k.contact_id, k.created_at, ${OWNER_OF_K} AS owner,
               COALESCE(ct.phone, k.contact_id) AS pessoa,
               COUNT(*) OVER (PARTITION BY COALESCE(ct.phone, k.contact_id)) AS n
        FROM ${OPEN_LEAD_CARDS(org)}
        JOIN contacts ct ON ct.id = k.contact_id
      ) g
      WHERE g.n > 1
      ORDER BY g.pessoa, g.created_at DESC`;
  }
}
