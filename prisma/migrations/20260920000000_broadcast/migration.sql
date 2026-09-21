-- Disparos em massa (WhatsApp Oficial)

-- Enums
DO $$ BEGIN CREATE TYPE "BroadcastStatus" AS ENUM ('DRAFT','SCHEDULED','RUNNING','PAUSED','COMPLETED','CANCELLED','FAILED'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "RecipientStatus" AS ENUM ('PENDING','QUEUED','SENT','DELIVERED','READ','FAILED','SKIPPED','OPTED_OUT'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "MessageCategory" AS ENUM ('MARKETING','UTILITY','AUTHENTICATION','SERVICE'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "LedgerType" AS ENUM ('RESERVE','CHARGE','RELEASE'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "BudgetPeriod" AS ENUM ('MONTHLY','TOTAL'); EXCEPTION WHEN duplicate_object THEN null; END $$;
DO $$ BEGIN CREATE TYPE "ImportStatus" AS ENUM ('PENDING','PROCESSING','COMPLETED','FAILED'); EXCEPTION WHEN duplicate_object THEN null; END $$;

-- Contact: opt-out de disparos
ALTER TABLE "contacts" ADD COLUMN IF NOT EXISTS "broadcast_opted_out_at" TIMESTAMP(3);

-- Rate card
CREATE TABLE IF NOT EXISTS "message_pricing" (
  "id" TEXT NOT NULL,
  "country_code" TEXT NOT NULL,
  "category" "MessageCategory" NOT NULL,
  "amount_micros" BIGINT NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "effective_from" TIMESTAMP(3) NOT NULL,
  "effective_to" TIMESTAMP(3),
  "source" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "message_pricing_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "message_pricing_country_code_category_effective_from_idx"
  ON "message_pricing"("country_code","category","effective_from");

-- Teto por empresa
CREATE TABLE IF NOT EXISTS "organization_broadcast_budgets" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "cap_micros" BIGINT NOT NULL,
  "period" "BudgetPeriod" NOT NULL DEFAULT 'MONTHLY',
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "organization_broadcast_budgets_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "organization_broadcast_budgets_organization_id_key"
  ON "organization_broadcast_budgets"("organization_id");
ALTER TABLE "organization_broadcast_budgets"
  ADD CONSTRAINT "organization_broadcast_budgets_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Broadcasts
CREATE TABLE IF NOT EXISTS "broadcasts" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "channel_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "template_name" TEXT NOT NULL,
  "template_language" TEXT NOT NULL,
  "template_category" "MessageCategory" NOT NULL,
  "variables_mapping" JSONB,
  "audience_filter" JSONB NOT NULL,
  "status" "BroadcastStatus" NOT NULL DEFAULT 'DRAFT',
  "scheduled_at" TIMESTAMP(3),
  "throttle_per_minute" INTEGER NOT NULL DEFAULT 600,
  "estimated_recipients" INTEGER NOT NULL DEFAULT 0,
  "estimated_cost_micros" BIGINT NOT NULL DEFAULT 0,
  "actual_cost_micros" BIGINT NOT NULL DEFAULT 0,
  "currency" TEXT NOT NULL DEFAULT 'BRL',
  "created_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "broadcasts_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "broadcasts_organization_id_status_idx" ON "broadcasts"("organization_id","status");
ALTER TABLE "broadcasts"
  ADD CONSTRAINT "broadcasts_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Ledger
CREATE TABLE IF NOT EXISTS "broadcast_ledger_entries" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "broadcast_id" TEXT NOT NULL,
  "type" "LedgerType" NOT NULL,
  "amount_micros" BIGINT NOT NULL,
  "note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "broadcast_ledger_entries_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "broadcast_ledger_entries_organization_id_created_at_idx" ON "broadcast_ledger_entries"("organization_id","created_at");
CREATE INDEX IF NOT EXISTS "broadcast_ledger_entries_broadcast_id_idx" ON "broadcast_ledger_entries"("broadcast_id");
ALTER TABLE "broadcast_ledger_entries"
  ADD CONSTRAINT "broadcast_ledger_entries_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "broadcast_ledger_entries"
  ADD CONSTRAINT "broadcast_ledger_entries_broadcast_id_fkey"
  FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Recipients
CREATE TABLE IF NOT EXISTS "broadcast_recipients" (
  "id" TEXT NOT NULL,
  "broadcast_id" TEXT NOT NULL,
  "contact_id" TEXT NOT NULL,
  "phone_e164" TEXT NOT NULL,
  "status" "RecipientStatus" NOT NULL DEFAULT 'PENDING',
  "wamid" TEXT,
  "error_code" TEXT,
  "error_message" TEXT,
  "estimated_amount_micros" BIGINT NOT NULL DEFAULT 0,
  "billed_category" "MessageCategory",
  "billed_amount_micros" BIGINT,
  "sent_at" TIMESTAMP(3),
  "delivered_at" TIMESTAMP(3),
  "read_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "broadcast_recipients_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "broadcast_recipients_wamid_key" ON "broadcast_recipients"("wamid");
CREATE UNIQUE INDEX IF NOT EXISTS "broadcast_recipients_broadcast_id_contact_id_key" ON "broadcast_recipients"("broadcast_id","contact_id");
CREATE INDEX IF NOT EXISTS "broadcast_recipients_broadcast_id_status_idx" ON "broadcast_recipients"("broadcast_id","status");
ALTER TABLE "broadcast_recipients"
  ADD CONSTRAINT "broadcast_recipients_broadcast_id_fkey"
  FOREIGN KEY ("broadcast_id") REFERENCES "broadcasts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "broadcast_recipients"
  ADD CONSTRAINT "broadcast_recipients_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Imports
CREATE TABLE IF NOT EXISTS "contact_imports" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "file_name" TEXT NOT NULL,
  "storage_path" TEXT NOT NULL,
  "status" "ImportStatus" NOT NULL DEFAULT 'PENDING',
  "total_rows" INTEGER NOT NULL DEFAULT 0,
  "created_count" INTEGER NOT NULL DEFAULT 0,
  "updated_count" INTEGER NOT NULL DEFAULT 0,
  "skipped_count" INTEGER NOT NULL DEFAULT 0,
  "error_report" JSONB,
  "created_by_user_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "contact_imports_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "contact_imports_organization_id_created_at_idx" ON "contact_imports"("organization_id","created_at");
ALTER TABLE "contact_imports"
  ADD CONSTRAINT "contact_imports_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Seed do rate card BR (repasse; conferir contra o rate card real da conta).
INSERT INTO "message_pricing" ("id","country_code","category","amount_micros","currency","effective_from","source")
VALUES
  (gen_random_uuid()::text,'BR','MARKETING',340000,'BRL', now(), 'seed'),
  (gen_random_uuid()::text,'BR','UTILITY',50000,'BRL', now(), 'seed'),
  (gen_random_uuid()::text,'BR','AUTHENTICATION',170000,'BRL', now(), 'seed'),
  (gen_random_uuid()::text,'BR','SERVICE',0,'BRL', now(), 'seed')
ON CONFLICT DO NOTHING;
