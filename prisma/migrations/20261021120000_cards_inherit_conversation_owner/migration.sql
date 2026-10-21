-- Backfill: cards SEM vendedor cujo contato tem conversa COM vendedor herdam
-- esse vendedor (mesma regra que passou a valer em tempo real: o card do lead
-- herda o responsável da conversa).
-- Prioridade: a conversa vinculada ao próprio card; senão a conversa do
-- contato com mensagem mais recente. Só vendedores que ainda são membros da
-- empresa. Vale para qualquer status (aberto, ganho, perdido) — corrige as
-- métricas por vendedor do histórico. Idempotente.
UPDATE cards k
SET assigned_to_id = x.uid
FROM (
  SELECT DISTINCT ON (k2.id) k2.id AS card_id, cv.assigned_to_id AS uid
  FROM cards k2
  JOIN conversations cv
    ON cv.contact_id = k2.contact_id
   AND cv.organization_id = k2.organization_id
   AND cv.assigned_to_id IS NOT NULL
   AND cv.deleted_at IS NULL
  JOIN user_organizations uo
    ON uo.user_id = cv.assigned_to_id
   AND uo.organization_id = cv.organization_id
  WHERE k2.assigned_to_id IS NULL
  ORDER BY k2.id, (cv.id = k2.conversation_id) DESC, cv.last_message_at DESC NULLS LAST
) x
WHERE k.id = x.card_id
  AND k.assigned_to_id IS NULL;
