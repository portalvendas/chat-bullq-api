-- Config da integração Meta Conversions API (CAPI), por organização.
CREATE TABLE "meta_capi_configs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "pixel_id" TEXT,
  "access_token" TEXT,
  "api_version" TEXT NOT NULL DEFAULT 'v21.0',
  "test_event_code" TEXT,
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "purchase_situacoes" JSONB NOT NULL DEFAULT '["Faturada","Aprovada"]',
  "add_to_cart_enabled" BOOLEAN NOT NULL DEFAULT true,
  "add_to_cart_situacoes" JSONB NOT NULL DEFAULT '[]',
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "meta_capi_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "meta_capi_configs_organization_id_key" ON "meta_capi_configs"("organization_id");

ALTER TABLE "meta_capi_configs"
  ADD CONSTRAINT "meta_capi_configs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Log + idempotência de eventos enviados.
CREATE TABLE "meta_capi_events" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "tiny_document_id" TEXT NOT NULL,
  "event_name" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "http_status" INTEGER,
  "fb_trace_id" TEXT,
  "error" TEXT,
  "value" DECIMAL(14,2),
  "event_id" TEXT,
  "sent_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "meta_capi_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_capi_doc_event" ON "meta_capi_events"("tiny_document_id", "event_name");
CREATE INDEX "idx_capi_org_event" ON "meta_capi_events"("organization_id", "event_name");

ALTER TABLE "meta_capi_events"
  ADD CONSTRAINT "meta_capi_events_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "meta_capi_events"
  ADD CONSTRAINT "meta_capi_events_tiny_document_id_fkey"
  FOREIGN KEY ("tiny_document_id") REFERENCES "tiny_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
