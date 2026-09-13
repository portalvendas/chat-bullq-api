-- Expediente canônico (fonte única de horário de funcionamento).
-- Rege IA, watchdog, salesbots e métricas. Substitui ai_business_hours /
-- watchdog_business_hours (colunas antigas mantidas por compat de dados).

ALTER TABLE "organizations"
  ADD COLUMN "business_hours_24_7" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN "business_timezone" TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
  ADD COLUMN "business_hours_schedule" JSONB,
  ADD COLUMN "business_holidays" JSONB,
  ADD COLUMN "business_out_of_hours_message" TEXT;

-- Data migration: preserva o que a org já tinha.
--  * Se já havia horário da IA configurado (ai_business_hours != NULL), adota-o
--    como agenda do expediente e marca como NÃO 24/7.
--  * Caso contrário, mantém 24/7 (comportamento atual) e semeia um template
--    Seg–Sex 08:00–17:30 pronto pra uso (basta desligar o 24/7 na tela).
--  * Carrega fuso e mensagem de fora de horário da config antiga da IA.
UPDATE "organizations" SET
  "business_timezone" = COALESCE(NULLIF("ai_timezone", ''), 'America/Sao_Paulo'),
  "business_out_of_hours_message" = "ai_out_of_hours_message",
  "business_hours_24_7" = ("ai_business_hours" IS NULL),
  "business_hours_schedule" = COALESCE(
    "ai_business_hours",
    '{
      "monday":    {"enabled": true,  "windows": [["08:00","17:30"]]},
      "tuesday":   {"enabled": true,  "windows": [["08:00","17:30"]]},
      "wednesday": {"enabled": true,  "windows": [["08:00","17:30"]]},
      "thursday":  {"enabled": true,  "windows": [["08:00","17:30"]]},
      "friday":    {"enabled": true,  "windows": [["08:00","17:30"]]},
      "saturday":  {"enabled": false, "windows": []},
      "sunday":    {"enabled": false, "windows": []}
    }'::jsonb
  );
