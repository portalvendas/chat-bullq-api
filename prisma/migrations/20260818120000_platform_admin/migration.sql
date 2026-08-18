-- Console de super-admin (plataforma multi-empresa).
-- Adiciona: papel de plataforma no usuário, suspensão de org e trilha de auditoria.

-- 1) Enum de papel de plataforma
CREATE TYPE "PlatformRole" AS ENUM ('SUPER_ADMIN');

-- 2) Coluna platform_role no usuário (NULL = usuário comum)
ALTER TABLE "users" ADD COLUMN "platform_role" "PlatformRole";

-- 3) Suspensão de organização (enforcement no OrgGuard)
ALTER TABLE "organizations" ADD COLUMN "suspended_at" TIMESTAMP(3);
ALTER TABLE "organizations" ADD COLUMN "suspended_reason" TEXT;

-- 4) Trilha de auditoria das ações de super-admin
CREATE TABLE "platform_audit_logs" (
    "id" TEXT NOT NULL,
    "actor_user_id" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT,
    "organization_id" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "ip_address" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "platform_audit_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "platform_audit_logs_organization_id_idx" ON "platform_audit_logs"("organization_id");
CREATE INDEX "platform_audit_logs_actor_user_id_idx" ON "platform_audit_logs"("actor_user_id");
CREATE INDEX "platform_audit_logs_created_at_idx" ON "platform_audit_logs"("created_at");

ALTER TABLE "platform_audit_logs"
  ADD CONSTRAINT "platform_audit_logs_actor_user_id_fkey"
  FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "platform_audit_logs"
  ADD CONSTRAINT "platform_audit_logs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
