-- Limpeza pontual da base de leads (2026-08-14)
-- Reatribui leads ativos para Gabriella (except. pedidos da Kelen -> Kelen),
-- protege contatos com pedido, e arquiva os cards parados >60d numa etapa
-- dedicada "Arquivados" no Funil de Vendas. Data-only, one-shot.

-- 1) Etapa "Arquivados" no Funil de Vendas (idempotente; type default = NORMAL)
INSERT INTO pipeline_stages (id, pipeline_id, name, color, "order", created_at)
SELECT 'stg_arquivados_fdv', 'cmrm87w4p0001e744ulian1hn', 'Arquivados', 'zinc',
       COALESCE((SELECT MAX("order") + 1 FROM pipeline_stages
                 WHERE pipeline_id = 'cmrm87w4p0001e744ulian1hn'), 99),
       now()
WHERE NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE id = 'stg_arquivados_fdv');

-- 2) Arquiva cards OPEN parados >60d cujo contato NAO tem pedido (protege clientes)
UPDATE cards SET stage_id = 'stg_arquivados_fdv', updated_at = now()
WHERE id IN (
  SELECT c.id FROM cards c
  LEFT JOIN conversations cv ON cv.id = c.conversation_id
  WHERE c.organization_id = 'cmr6yc4y80001bm45fj37u4bp' AND c.status = 'OPEN'
    AND COALESCE(cv.last_message_at, c.created_at) < now() - interval '60 days'
    AND (c.contact_id IS NULL OR c.contact_id NOT IN (
      SELECT DISTINCT contact_id FROM tiny_documents
      WHERE organization_id = 'cmr6yc4y80001bm45fj37u4bp' AND kind = 'PEDIDO'
        AND contact_id IS NOT NULL
    ))
);

-- 3) Cards ATIVOS de contatos com pedido da Kelen -> Kelen
UPDATE cards SET assigned_to_id = 'cmrjb3pp7001abz1ysxfu5go8', updated_at = now()
WHERE organization_id = 'cmr6yc4y80001bm45fj37u4bp' AND status = 'OPEN'
  AND stage_id <> 'stg_arquivados_fdv'
  AND contact_id IN (
    SELECT DISTINCT contact_id FROM tiny_documents
    WHERE organization_id = 'cmr6yc4y80001bm45fj37u4bp' AND kind = 'PEDIDO'
      AND vendedor = 'Kelen do Rosario de Moraes' AND contact_id IS NOT NULL
  );

-- 4) Demais cards ATIVOS -> Gabriella
UPDATE cards SET assigned_to_id = 'cmsdffc1q01aimg1znjjqwmb5', updated_at = now()
WHERE organization_id = 'cmr6yc4y80001bm45fj37u4bp' AND status = 'OPEN'
  AND stage_id <> 'stg_arquivados_fdv'
  AND (contact_id IS NULL OR contact_id NOT IN (
    SELECT DISTINCT contact_id FROM tiny_documents
    WHERE organization_id = 'cmr6yc4y80001bm45fj37u4bp' AND kind = 'PEDIDO'
      AND vendedor = 'Kelen do Rosario de Moraes' AND contact_id IS NOT NULL
  ));

-- 5) Conversas de contatos com pedido da Kelen -> Kelen
UPDATE conversations SET assigned_to_id = 'cmrjb3pp7001abz1ysxfu5go8'
WHERE organization_id = 'cmr6yc4y80001bm45fj37u4bp' AND deleted_at IS NULL
  AND contact_id IN (
    SELECT DISTINCT contact_id FROM tiny_documents
    WHERE organization_id = 'cmr6yc4y80001bm45fj37u4bp' AND kind = 'PEDIDO'
      AND vendedor = 'Kelen do Rosario de Moraes' AND contact_id IS NOT NULL
  );

-- 6) Demais conversas -> Gabriella
UPDATE conversations SET assigned_to_id = 'cmsdffc1q01aimg1znjjqwmb5'
WHERE organization_id = 'cmr6yc4y80001bm45fj37u4bp' AND deleted_at IS NULL
  AND (contact_id IS NULL OR contact_id NOT IN (
    SELECT DISTINCT contact_id FROM tiny_documents
    WHERE organization_id = 'cmr6yc4y80001bm45fj37u4bp' AND kind = 'PEDIDO'
      AND vendedor = 'Kelen do Rosario de Moraes' AND contact_id IS NOT NULL
  ));
