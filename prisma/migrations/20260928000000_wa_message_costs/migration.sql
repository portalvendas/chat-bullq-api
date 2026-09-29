-- Custo real por mensagem (capturado do pricing do webhook da Meta).
-- O tipo enum "MessageCategory" já existe (criado na migration de broadcast).
CREATE TABLE "wa_message_costs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "wamid" TEXT NOT NULL,
    "category" "MessageCategory" NOT NULL,
    "billable" BOOLEAN NOT NULL DEFAULT true,
    "pricing_model" TEXT,
    "wa_conversation_id" TEXT,
    "origin_type" TEXT,
    "cost_micros" BIGINT NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'BRL',
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "wa_message_costs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "wa_message_costs_wamid_key" ON "wa_message_costs"("wamid");

CREATE INDEX "wa_message_costs_organization_id_channel_id_occurred_at_idx" ON "wa_message_costs"("organization_id", "channel_id", "occurred_at");

CREATE INDEX "wa_message_costs_channel_id_category_occurred_at_idx" ON "wa_message_costs"("channel_id", "category", "occurred_at");
