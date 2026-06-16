-- AlterTable
ALTER TABLE "conversations"
  ADD COLUMN "is_archived" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "archived_at" TIMESTAMP(3),
  ADD COLUMN "archived_by_id" TEXT;

-- CreateIndex
CREATE INDEX "idx_conv_org_archived" ON "conversations"("organization_id", "is_archived");

-- AlterTable: inbox_views ganha metadata pra distinguir builtin views (Archived) de custom
ALTER TABLE "inbox_views"
  ADD COLUMN "metadata" JSONB NOT NULL DEFAULT '{}';
