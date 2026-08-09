-- Notificação de card parado no funil (sem interação).
ALTER TYPE "NotificationType" ADD VALUE IF NOT EXISTS 'CARD_INACTIVE';

-- Prazo de inatividade (em horas) configurável por FUNIL e por ETAPA.
-- Regra de herança: etapa.inactivity_hours ?? pipeline.inactivity_hours.
-- NULL nos dois = alerta de inatividade desligado para aquele card.
ALTER TABLE "pipelines" ADD COLUMN IF NOT EXISTS "inactivity_hours" INTEGER;
ALTER TABLE "pipeline_stages" ADD COLUMN IF NOT EXISTS "inactivity_hours" INTEGER;
