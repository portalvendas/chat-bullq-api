-- Recuperação de orçamentos (agente de IA)
DO $$ BEGIN
  CREATE TYPE "ProposalRecoveryStatus" AS ENUM ('CONTACTED','ENGAGED','HANDED_OFF','WON','LOST','EXPIRED','OPTED_OUT','SKIPPED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "proposal_recoveries" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "tiny_document_id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  "conversation_id" TEXT NOT NULL,
  "agent_id" TEXT,
  "vendor_name" TEXT,
  "vendor_user_id" TEXT,
  "status" "ProposalRecoveryStatus" NOT NULL DEFAULT 'CONTACTED',
  "offer" JSONB NOT NULL,
  "offer_expires_at" TIMESTAMP(3) NOT NULL,
  "chosen_option" TEXT,
  "objection" TEXT,
  "lost_reason" TEXT,
  "notes" TEXT,
  "previous_ai_state" JSONB,
  "won_pedido_id" TEXT,
  "won_value" DECIMAL(14,2),
  "last_customer_message_at" TIMESTAMP(3) NOT NULL,
  "kicked_off_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "proposal_recoveries_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "proposal_recoveries_tiny_document_id_key" ON "proposal_recoveries"("tiny_document_id");
CREATE INDEX IF NOT EXISTS "idx_prec_org_status" ON "proposal_recoveries"("organization_id","status");
CREATE INDEX IF NOT EXISTS "idx_prec_conv" ON "proposal_recoveries"("conversation_id");
CREATE INDEX IF NOT EXISTS "idx_prec_contact" ON "proposal_recoveries"("contact_id");
