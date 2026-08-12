-- Rotina Comercial: config por org + marcações diárias do checklist.
CREATE TABLE IF NOT EXISTS "commercial_routine_configs" (
  "id"              TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "enabled"         BOOLEAN NOT NULL DEFAULT true,
  "steps"           JSONB NOT NULL DEFAULT '[]',
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"      TIMESTAMP(3) NOT NULL,
  CONSTRAINT "commercial_routine_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "commercial_routine_configs_organization_id_key"
  ON "commercial_routine_configs"("organization_id");
ALTER TABLE "commercial_routine_configs"
  ADD CONSTRAINT "commercial_routine_configs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "routine_daily_checks" (
  "id"              TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "user_id"         TEXT NOT NULL,
  "day"             TEXT NOT NULL,
  "step_key"        TEXT NOT NULL,
  "created_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "routine_daily_checks_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_routine_check"
  ON "routine_daily_checks"("organization_id", "user_id", "day", "step_key");
CREATE INDEX IF NOT EXISTS "routine_daily_checks_org_user_day_idx"
  ON "routine_daily_checks"("organization_id", "user_id", "day");
ALTER TABLE "routine_daily_checks"
  ADD CONSTRAINT "routine_daily_checks_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "routine_daily_checks"
  ADD CONSTRAINT "routine_daily_checks_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
