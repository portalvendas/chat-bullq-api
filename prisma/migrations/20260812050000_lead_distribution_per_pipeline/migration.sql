-- Pesos POR FUNIL: [{ pipelineId, weights: [{ userId, weight }] }].
-- pipelineId = '*' é o padrão aplicado aos demais funis.
ALTER TABLE "lead_distribution_configs"
  ADD COLUMN IF NOT EXISTS "pipeline_weights" JSONB NOT NULL DEFAULT '[]';

-- Migra pesos globais legados (coluna weights) para uma regra padrão "*",
-- apenas quando ainda não há regras por funil configuradas.
UPDATE "lead_distribution_configs"
SET "pipeline_weights" = jsonb_build_array(
      jsonb_build_object('pipelineId', '*', 'weights', "weights")
    )
WHERE "pipeline_weights" = '[]'::jsonb
  AND "weights" IS NOT NULL
  AND jsonb_array_length("weights") > 0;
