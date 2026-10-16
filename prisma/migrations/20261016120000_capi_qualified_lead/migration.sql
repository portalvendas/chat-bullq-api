-- Evento de LEAD QUALIFICADO via Meta CAPI (toggle + nome do evento).
ALTER TABLE "meta_capi_configs"
  ADD COLUMN "qualified_lead_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "qualified_lead_event_name" TEXT NOT NULL DEFAULT 'QualifiedLead';

-- Log + idempotência por contato (1 evento de qualificação por lead).
CREATE TABLE "meta_capi_lead_events" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  "event_name" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "action_source" TEXT,
  "reason" TEXT,
  "attempts" INTEGER NOT NULL DEFAULT 1,
  "http_status" INTEGER,
  "fb_trace_id" TEXT,
  "error" TEXT,
  "event_id" TEXT,
  "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "meta_capi_lead_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_capi_lead_contact_event" ON "meta_capi_lead_events"("contact_id", "event_name");
CREATE INDEX "idx_capi_lead_org_event" ON "meta_capi_lead_events"("organization_id", "event_name");

ALTER TABLE "meta_capi_lead_events"
  ADD CONSTRAINT "meta_capi_lead_events_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
