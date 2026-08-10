-- Grupos de permissão (RBAC).
CREATE TABLE IF NOT EXISTS "permission_groups" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "description" TEXT,
  "module_perms" JSONB NOT NULL DEFAULT '{}',
  "all_channels" BOOLEAN NOT NULL DEFAULT true,
  "channel_ids" JSONB NOT NULL DEFAULT '[]',
  "all_pipelines" BOOLEAN NOT NULL DEFAULT true,
  "pipeline_ids" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "permission_groups_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_permgroup_org_name"
  ON "permission_groups"("organization_id", "name");

ALTER TABLE "permission_groups"
  ADD CONSTRAINT "permission_groups_org_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- Vínculo do grupo no membro.
ALTER TABLE "user_organizations"
  ADD COLUMN IF NOT EXISTS "permission_group_id" TEXT;

ALTER TABLE "user_organizations"
  ADD CONSTRAINT "user_organizations_permgroup_fkey"
  FOREIGN KEY ("permission_group_id") REFERENCES "permission_groups"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
