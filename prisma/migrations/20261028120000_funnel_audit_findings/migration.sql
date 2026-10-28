-- Auditoria de Funil: checagens do processo comercial (achados por lead) +
-- contador no run. Rodada também agendada (3x/dia, seg–sáb).
ALTER TABLE "funnel_audit_runs" ADD COLUMN IF NOT EXISTS "findings" INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS "funnel_audit_findings" (
  "id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "severity" TEXT NOT NULL DEFAULT 'MEDIUM',
  "card_id" TEXT,
  "conversation_id" TEXT,
  "contact_id" TEXT,
  "owner_user_id" TEXT,
  "minutes" INTEGER,
  "details" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "funnel_audit_findings_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "funnel_audit_findings_run_id_type_idx" ON "funnel_audit_findings"("run_id", "type");
CREATE INDEX IF NOT EXISTS "funnel_audit_findings_organization_id_created_at_idx" ON "funnel_audit_findings"("organization_id", "created_at");
ALTER TABLE "funnel_audit_findings" ADD CONSTRAINT "funnel_audit_findings_run_id_fkey"
  FOREIGN KEY ("run_id") REFERENCES "funnel_audit_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "funnel_audit_findings" ADD CONSTRAINT "funnel_audit_findings_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
