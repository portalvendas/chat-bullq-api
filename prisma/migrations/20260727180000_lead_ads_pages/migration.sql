CREATE TABLE IF NOT EXISTS "lead_ads_pages" (
  "id"              TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "page_id"         TEXT NOT NULL,
  "page_name"       TEXT,
  "access_token"    TEXT NOT NULL,
  "active"          BOOLEAN NOT NULL DEFAULT true,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "lead_ads_pages_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "lead_ads_pages_page_id_key" ON "lead_ads_pages" ("page_id");
CREATE INDEX IF NOT EXISTS "idx_leadads_org" ON "lead_ads_pages" ("organization_id");
ALTER TABLE "lead_ads_pages" ADD CONSTRAINT "lead_ads_pages_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
