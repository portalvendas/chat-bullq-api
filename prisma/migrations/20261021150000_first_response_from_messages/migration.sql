-- "1ª resposta" da conversa = 1ª mensagem ENVIADA (robô ou humano, CRM ou
-- celular) depois que o cliente escreveu. Antes era gravada na ATRIBUIÇÃO da
-- conversa (FSM/automação), que não é resposta — e respostas reais não a
-- gravavam. Regra alinhada a "cliente atendido pelo robô conta como resposta".
-- Usada no Dashboard (tempo de 1ª resposta, SLA, por agente) e no SLA timer.

-- 1) Trigger: mantém o campo em TODO caminho de envio (CRM, robô, cadência,
--    eco do celular), sem depender de cada serviço lembrar.
CREATE OR REPLACE FUNCTION kortia_set_first_response() RETURNS trigger AS $$
BEGIN
  IF NEW.direction = 'OUTBOUND' THEN
    UPDATE conversations c
    SET first_response_at = NEW.created_at
    WHERE c.id = NEW.conversation_id
      AND c.first_response_at IS NULL
      AND EXISTS (
        SELECT 1 FROM messages i
        WHERE i.conversation_id = NEW.conversation_id
          AND i.direction = 'INBOUND'
          AND i.created_at <= NEW.created_at
      );
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_messages_first_response ON messages;
CREATE TRIGGER trg_messages_first_response
AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION kortia_set_first_response();

-- 2) Recalcula o histórico com a regra nova (NULL = cliente nunca recebeu
--    resposta depois de escrever).
WITH fi AS (
  SELECT conversation_id, MIN(created_at) AS t
  FROM messages WHERE direction = 'INBOUND' GROUP BY 1
),
fo AS (
  SELECT m.conversation_id, MIN(m.created_at) AS t
  FROM messages m JOIN fi ON fi.conversation_id = m.conversation_id
  WHERE m.direction = 'OUTBOUND' AND m.created_at >= fi.t
  GROUP BY 1
)
UPDATE conversations c
SET first_response_at = fo.t
FROM conversations c2
LEFT JOIN fo ON fo.conversation_id = c2.id
WHERE c.id = c2.id
  AND c.first_response_at IS DISTINCT FROM fo.t;
