-- Templates de mensagem do WhatsApp Business (HSM) aprovados pela Meta.
CREATE TABLE IF NOT EXISTS "whatsapp_templates" (
  "id"              TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "channel_id"      TEXT,
  "external_id"     TEXT,
  "name"            TEXT NOT NULL,
  "status"          TEXT NOT NULL DEFAULT 'APPROVED',
  "category"        TEXT NOT NULL DEFAULT 'MARKETING',
  "language"        TEXT NOT NULL DEFAULT 'pt_BR',
  "waba"            TEXT,
  "body_text"       TEXT NOT NULL,
  "components"      JSONB NOT NULL DEFAULT '[]',
  "source"          TEXT NOT NULL DEFAULT 'SEED',
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "whatsapp_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_wa_template"
  ON "whatsapp_templates" ("organization_id", "waba", "name", "language");
CREATE INDEX IF NOT EXISTS "idx_wa_template_org_status"
  ON "whatsapp_templates" ("organization_id", "status");

ALTER TABLE "whatsapp_templates"
  ADD CONSTRAINT "whatsapp_templates_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
