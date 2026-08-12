-- Ativação da rotina por usuário: modo (todos/selecionados) + lista de userIds.
ALTER TABLE "commercial_routine_configs"
  ADD COLUMN IF NOT EXISTS "user_mode" TEXT NOT NULL DEFAULT 'ALL',
  ADD COLUMN IF NOT EXISTS "user_ids" JSONB NOT NULL DEFAULT '[]';
