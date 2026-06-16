-- ============================================================================
-- Watchdog — detecção de conversas presas
-- ============================================================================
-- Adiciona infra para o watchdog que detecta e reativa conversas onde:
--   - IA travou no meio (status=BOT, última msg INBOUND, sem resposta)
--   - Ninguém pegou o atendimento (status=PENDING, última msg INBOUND)
--   - Humano abandonou (status=OPEN, atribuído mas há 1h+ sem responder)
--
-- Estrutura:
--   1. Organization ganha config de watchdog (enabled, business hours, params)
--   2. Conversation ganha contador de tentativas + flag isStuck + jobId pra
--      cancelamento de jobs reativos
-- ============================================================================

-- 1. Organization: config do watchdog
ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "watchdog_enabled" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "watchdog_business_hours" JSONB,
  ADD COLUMN IF NOT EXISTS "watchdog_config" JSONB;

-- 2. Conversation: estado do watchdog
ALTER TABLE "conversations"
  ADD COLUMN IF NOT EXISTS "stuck_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "last_watchdog_check_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "watchdog_job_id" TEXT,
  ADD COLUMN IF NOT EXISTS "is_stuck" BOOLEAN NOT NULL DEFAULT false;

-- Índice pra query do cron de fallback (pegar conversas potencialmente presas)
CREATE INDEX IF NOT EXISTS "idx_conv_watchdog_scan"
  ON "conversations" ("organization_id", "status", "last_message_at")
  WHERE "deleted_at" IS NULL;
