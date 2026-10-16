-- Etapas do funil escolhidas como "lead qualificado" (substitui "avançou qualquer etapa").
ALTER TABLE "meta_capi_configs"
  ADD COLUMN "qualified_lead_stage_ids" JSONB NOT NULL DEFAULT '[]';
