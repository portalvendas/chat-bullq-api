-- Corte mínimo do lead score (LP) para "lead qualificado". Padrão 60
-- (40-59 convertia igual a lead sem score).
ALTER TABLE "meta_capi_configs"
  ADD COLUMN "qualified_lead_min_score" INTEGER NOT NULL DEFAULT 60;
