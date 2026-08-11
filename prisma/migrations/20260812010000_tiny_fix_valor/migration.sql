-- Corrige valores inflados ~100x: o parser antigo removia o ponto decimal do
-- formato americano do Tiny ("624.59" -> 62459). Recomputa `valor` direto do
-- payload cru (que está no formato correto), só para linhas cujo valor cru é
-- um decimal americano válido (evita erro de cast em formatos inesperados).
UPDATE "tiny_documents"
SET "valor" = (NULLIF("raw"->>'valor', ''))::numeric
WHERE "kind" = 'PEDIDO'
  AND "raw"->>'valor' ~ '^[0-9]+(\.[0-9]+)?$';

UPDATE "tiny_documents"
SET "valor" = (NULLIF("raw"->>'valorTotal', ''))::numeric
WHERE "kind" = 'ORCAMENTO'
  AND "raw"->>'valorTotal' ~ '^[0-9]+(\.[0-9]+)?$';
