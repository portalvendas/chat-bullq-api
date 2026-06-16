-- Texto livre que vai pro system prompt de TODOS os agentes da org.
-- JP edita em Configurações → IA. Caso de uso: regras de entrega,
-- horários de live, política de reembolso, talking points atuais.

ALTER TABLE "organizations"
  ADD COLUMN "ai_business_notes" TEXT;
