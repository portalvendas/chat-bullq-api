-- Salesbot: janela de execução por horário (Expediente).
-- ALWAYS | BUSINESS_HOURS | OUTSIDE_HOURS, avaliada no disparo (start).
ALTER TABLE "cadences"
  ADD COLUMN "run_window" TEXT NOT NULL DEFAULT 'ALWAYS';

-- Bots que tinham o header "só em horário comercial" marcado passam a
-- realmente só disparar dentro do expediente (antes o flag era inerte em bots
-- de grafo). Preserva a intenção do rótulo.
UPDATE "cadences" SET "run_window" = 'BUSINESS_HOURS' WHERE "business_hours_only" = true;
