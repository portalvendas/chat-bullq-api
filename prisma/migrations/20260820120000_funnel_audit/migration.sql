-- Auditoria de funil de vendas: runs + sugestões de mudança de etapa (revisão manual).

CREATE TYPE "FunnelAuditStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED');
CREATE TYPE "FunnelSuggestionStatus" AS ENUM ('PENDING', 'APPLIED', 'DISMISSED');

CREATE TABLE "funnel_audit_runs" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "status" "FunnelAuditStatus" NOT NULL DEFAULT 'RUNNING',
    "requested_by_id" TEXT,
    "window_days" INTEGER NOT NULL DEFAULT 60,
    "cards_scanned" INTEGER NOT NULL DEFAULT 0,
    "cards_flagged" INTEGER NOT NULL DEFAULT 0,
    "suggestions" INTEGER NOT NULL DEFAULT 0,
    "ai_used" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMP(3),
    CONSTRAINT "funnel_audit_runs_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "funnel_audit_runs_organization_id_started_at_idx" ON "funnel_audit_runs"("organization_id", "started_at");

CREATE TABLE "funnel_audit_suggestions" (
    "id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "card_id" TEXT NOT NULL,
    "pipeline_id" TEXT NOT NULL,
    "current_stage_id" TEXT NOT NULL,
    "suggested_stage_id" TEXT,
    "action" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "confidence" TEXT NOT NULL DEFAULT 'MEDIUM',
    "source" TEXT NOT NULL DEFAULT 'rule',
    "status" "FunnelSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "applied_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "funnel_audit_suggestions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "funnel_audit_suggestions_organization_id_status_idx" ON "funnel_audit_suggestions"("organization_id", "status");
CREATE INDEX "funnel_audit_suggestions_run_id_idx" ON "funnel_audit_suggestions"("run_id");
CREATE INDEX "funnel_audit_suggestions_card_id_idx" ON "funnel_audit_suggestions"("card_id");

ALTER TABLE "funnel_audit_runs" ADD CONSTRAINT "funnel_audit_runs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "funnel_audit_suggestions" ADD CONSTRAINT "funnel_audit_suggestions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "funnel_audit_runs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "funnel_audit_suggestions" ADD CONSTRAINT "funnel_audit_suggestions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "funnel_audit_suggestions" ADD CONSTRAINT "funnel_audit_suggestions_card_id_fkey" FOREIGN KEY ("card_id") REFERENCES "cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;
