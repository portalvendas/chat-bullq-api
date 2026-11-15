-- Config por empresa da Auditoria de Funil (liga/desliga automático + horários + dias)
CREATE TABLE IF NOT EXISTS "funnel_audit_configs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "auto_enabled" BOOLEAN NOT NULL DEFAULT true,
  "times" TEXT[] NOT NULL DEFAULT ARRAY['08:30','12:30','16:30']::TEXT[],
  "weekdays" INTEGER[] NOT NULL DEFAULT ARRAY[1,2,3,4,5,6]::INTEGER[],
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "funnel_audit_configs_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "funnel_audit_configs_organization_id_key" ON "funnel_audit_configs"("organization_id");
DO $$ BEGIN
  ALTER TABLE "funnel_audit_configs" ADD CONSTRAINT "funnel_audit_configs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
