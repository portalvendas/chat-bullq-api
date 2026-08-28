CREATE TABLE IF NOT EXISTS "meta_ads_integrations" (
  "id" TEXT NOT NULL DEFAULT gen_random_uuid()::text,
  "organization_id" TEXT NOT NULL,
  "ad_account_id" TEXT NOT NULL,
  "access_token_enc" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active',
  "last_error" TEXT,
  "last_sync_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "meta_ads_integrations_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "meta_ads_integrations_organization_id_key" ON "meta_ads_integrations"("organization_id");
