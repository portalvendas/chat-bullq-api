-- Janela de debounce por canal (segundos). NULL = default do sistema (10s).
ALTER TABLE "channels" ADD COLUMN "ai_debounce_seconds" INTEGER;

-- Default do Mercado Livre: 120s (2min) — dá tempo do comprador mandar
-- todas as perguntas do anúncio antes da IA responder. WhatsApp/demais
-- ficam NULL (10s) preservando o comportamento atual.
UPDATE "channels" SET "ai_debounce_seconds" = 120 WHERE "type" = 'MERCADO_LIVRE';
