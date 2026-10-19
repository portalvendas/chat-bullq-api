-- Produtividade dos vendedores.
-- user_activity_minutes: 1 linha por vendedor por minuto com o CRM aberto
--   (heartbeat do navegador). ~600 linhas/vendedor/dia; limpeza automática
--   após 180 dias (job productivity-retention).
-- card_events: movimentos de card COM autor (cards movidos por vendedor).

CREATE TABLE IF NOT EXISTS "user_activity_minutes" (
  "organization_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "minute_at" TIMESTAMP(3) NOT NULL,
  "day" TEXT NOT NULL,
  "state" SMALLINT NOT NULL,
  "area" TEXT,
  "conversation_id" TEXT,
  CONSTRAINT "user_activity_minutes_pkey" PRIMARY KEY ("organization_id", "user_id", "minute_at")
);
CREATE INDEX IF NOT EXISTS "user_activity_minutes_organization_id_day_idx"
  ON "user_activity_minutes"("organization_id", "day");
ALTER TABLE "user_activity_minutes" ADD CONSTRAINT "user_activity_minutes_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_activity_minutes" ADD CONSTRAINT "user_activity_minutes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "card_events" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "card_id" TEXT NOT NULL,
  "user_id" TEXT,
  "type" TEXT NOT NULL,
  "from_stage_id" TEXT,
  "to_stage_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "card_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "card_events_organization_id_created_at_idx" ON "card_events"("organization_id", "created_at");
CREATE INDEX IF NOT EXISTS "card_events_card_id_idx" ON "card_events"("card_id");
ALTER TABLE "card_events" ADD CONSTRAINT "card_events_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "card_events" ADD CONSTRAINT "card_events_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Métricas por vendedor/dia varrem as mensagens de UM dia (CRM + celular).
CREATE INDEX IF NOT EXISTS "messages_created_at_idx" ON "messages"("created_at");
