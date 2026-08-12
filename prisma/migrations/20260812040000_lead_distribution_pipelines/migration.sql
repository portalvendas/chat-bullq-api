-- Escopo por funil na distribuição ponderada de leads.
-- Vazio ("[]") = distribui em todos os funis (comportamento anterior).
ALTER TABLE "lead_distribution_configs"
  ADD COLUMN IF NOT EXISTS "pipeline_ids" JSONB NOT NULL DEFAULT '[]';
