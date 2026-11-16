-- Vendedor virtual (IA): membro atendido por um agente, ligado a um AiAgent.
ALTER TABLE "user_organizations" ADD COLUMN "is_virtual" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "user_organizations" ADD COLUMN "ai_agent_id" TEXT;

ALTER TABLE "user_organizations"
  ADD CONSTRAINT "user_organizations_ai_agent_id_fkey"
  FOREIGN KEY ("ai_agent_id") REFERENCES "ai_agents"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "idx_user_org_ai_agent" ON "user_organizations"("ai_agent_id");
