-- Prazo de inatividade do funil passa de HORAS para MINUTOS (granularidade fina
-- p/ follow-up rápido). Renomeia a coluna e converte os valores existentes ×60
-- (24h -> 1440min), preservando a semântica de quem já tinha configurado.
ALTER TABLE "pipelines" RENAME COLUMN "inactivity_hours" TO "inactivity_minutes";
UPDATE "pipelines"
   SET "inactivity_minutes" = "inactivity_minutes" * 60
 WHERE "inactivity_minutes" IS NOT NULL;

ALTER TABLE "pipeline_stages" RENAME COLUMN "inactivity_hours" TO "inactivity_minutes";
UPDATE "pipeline_stages"
   SET "inactivity_minutes" = "inactivity_minutes" * 60
 WHERE "inactivity_minutes" IS NOT NULL;
