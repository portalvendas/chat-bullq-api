import { Prisma } from '@prisma/client';

/**
 * REGRA ÚNICA de "lead esperando resposta HUMANA" (usada no "Sem resposta" do
 * Pedidos & Propostas, no "Esperando" da Produtividade e no alerta ao vendedor).
 *
 * Mensagem humana = OUTBOUND enviada por um usuário no CRM (sender_id) OU pelo
 * celular do vendedor (eco: metadata.isEcho). Robô/IA/cadência/disparo = OUTBOUND
 * sem sender e sem eco.
 *
 * Olhando a ÚLTIMA mensagem do cliente (INBOUND) que pede resposta — ignora
 * reação, figurinha e agradecimento curto ("ok", "obrigado", "👍"):
 *  - houve resposta HUMANA depois dela                         → respondido;
 *  - é a ABERTURA (nada foi enviado antes) e o robô respondeu  → respondido
 *    ("cliente entrou e foi atendido pelo robô");
 *  - caso contrário                                            → ESPERANDO:
 *      'nunca_respondido'    = cliente escreveu e nada foi enviado;
 *      'apos_robo'           = cliente respondeu ao robô (só robô falou antes);
 *      'aguardando_vendedor' = já houve humano antes, o cliente voltou a falar
 *                              e ninguém respondeu.
 *    Mensagens automáticas DEPOIS da resposta do cliente (follow-up do robô)
 *    não contam como resposta.
 *
 * Exemplo (linha do tempo → resultado):
 *   cliente "oi" → robô "olá!"                        → respondido
 *   cliente "oi" → robô "olá!" → cliente "quero preço" → ESPERANDO (apos_robo)
 *   ... → robô follow-up                               → continua ESPERANDO
 *   ... → vendedora responde                           → respondido
 */
export type WaitingKind = 'nunca_respondido' | 'apos_robo' | 'aguardando_vendedor';

export interface WaitingRow {
  conversationId: string;
  organizationId: string;
  contactId: string;
  assignedToId: string | null;
  channelId: string;
  lastInboundId: string;
  waitingSince: Date;
  kind: WaitingKind;
}

/** Condição SQL: a mensagem `alias` é humana (CRM ou celular). */
export function humanOutboundSql(alias: string): Prisma.Sql {
  return Prisma.raw(
    `(${alias}.direction = 'OUTBOUND' AND (${alias}.sender_id IS NOT NULL OR ${alias}.metadata->>'isEcho' = 'true'))`,
  );
}

/**
 * Mensagem do cliente que PEDE resposta. Não contam: reação, figurinha,
 * mensagem de sistema e agradecimento/confirmação curto que encerra a conversa
 * ("ok", "obrigado", "valeu", "👍"...). Assim "cliente agradeceu e não teve
 * resposta" não vira lead esperando nem dispara alerta.
 */
const COURTESY_RE =
  '^[[:space:]]*(ok+|okay|oki|okk|obrigad[oa]s?|muito obrigad[oa]|ok,? obrigad[oa]|brigad[oa]|obg|valeu|vlw|blz|beleza|certo|perfeito|show|top|joia|j[oó]ia|t[aá] bom|t[aá] certo|combinado|de nada|am[eé]m|fechado|👍+|🙏+|❤️+|😊+|👏+|🙂+)[[:space:][:punct:]]*$';
const MEANINGFUL_INBOUND = Prisma.raw(`(
  m.type::text NOT IN ('REACTION','STICKER','SYSTEM')
  AND NOT (
    m.type::text = 'TEXT'
    AND length(COALESCE(m.content->>'text', m.content->>'body', '')) <= 40
    AND lower(COALESCE(m.content->>'text', m.content->>'body', '')) ~ '${COURTESY_RE}'
  )
)`);

/**
 * SELECT das conversas ESPERANDO resposta humana, filtradas por `where`
 * (aplicado em `conversations c`). Use como subconsulta/CTE.
 *
 * Colunas: "conversationId", "organizationId", "contactId", "assignedToId",
 * "channelId", "lastInboundId", "waitingSince", kind.
 */
export function waitingConversationsSql(where: Prisma.Sql): Prisma.Sql {
  const human = humanOutboundSql('o');
  return Prisma.sql`
    SELECT c.id AS "conversationId", c.organization_id AS "organizationId",
           c.contact_id AS "contactId", c.assigned_to_id AS "assignedToId",
           c.channel_id AS "channelId",
           li.id AS "lastInboundId", li.created_at AS "waitingSince",
           CASE WHEN NOT COALESCE(ob.any_before, false) THEN 'nunca_respondido'
                WHEN COALESCE(ob.human_before, false) THEN 'aguardando_vendedor'
                ELSE 'apos_robo' END AS kind
    FROM conversations c
    JOIN LATERAL (
      SELECT m.id, m.created_at FROM messages m
      WHERE m.conversation_id = c.id AND m.direction = 'INBOUND'
        AND ${MEANINGFUL_INBOUND}
      ORDER BY m.created_at DESC LIMIT 1
    ) li ON true
    LEFT JOIN LATERAL (
      SELECT bool_or(o.created_at > li.created_at AND ${human}) AS human_after,
             bool_or(o.created_at > li.created_at) AS any_after,
             bool_or(o.created_at < li.created_at) AS any_before,
             bool_or(o.created_at < li.created_at AND ${human}) AS human_before
      FROM messages o
      WHERE o.conversation_id = c.id AND o.direction = 'OUTBOUND'
    ) ob ON true
    WHERE (${where})
      AND c.is_group = false
      AND c.deleted_at IS NULL
      AND NOT COALESCE(ob.human_after, false)
      AND NOT (NOT COALESCE(ob.any_before, false) AND COALESCE(ob.any_after, false))`;
}

export const WAITING_KIND_LABEL: Record<WaitingKind, string> = {
  nunca_respondido: 'escreveu e não recebeu resposta',
  apos_robo: 'respondeu ao robô e ficou sem atendimento',
  aguardando_vendedor: 'voltou a falar e não teve resposta',
};
