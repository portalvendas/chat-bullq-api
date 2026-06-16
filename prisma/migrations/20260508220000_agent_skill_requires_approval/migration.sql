-- Gating configurável por (agent, skill).
-- Default false: skill executa direto. Operador habilita explicitamente
-- via UI quando quiser exigir aprovação humana antes da execução.
ALTER TABLE "ai_agent_skills"
  ADD COLUMN IF NOT EXISTS "requires_approval" BOOLEAN NOT NULL DEFAULT false;
