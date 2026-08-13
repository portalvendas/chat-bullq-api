-- Permite contar leads das etapas ignorando o responsável (validação / operação
-- sem atribuição). Padrão: false (conta só os leads atribuídos ao vendedor).
ALTER TABLE "commercial_routine_configs"
  ADD COLUMN IF NOT EXISTS "ignore_assignment" BOOLEAN NOT NULL DEFAULT false;
