-- CreateEnum
CREATE TYPE "KnowledgeType" AS ENUM ('FACT', 'FAQ', 'POLICY', 'VARIANT_MAP', 'AD_SPEC', 'LINK');

-- CreateEnum
CREATE TYPE "KnowledgeStatus" AS ENUM ('DRAFT', 'PENDING', 'VALIDATED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "KnowledgeSource" AS ENUM ('MANUAL', 'OPERATOR_COMPLEMENT', 'AD_SCAN', 'FILE_IMPORT');

-- CreateTable
CREATE TABLE "knowledge_items" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "type" "KnowledgeType" NOT NULL DEFAULT 'FACT',
    "status" "KnowledgeStatus" NOT NULL DEFAULT 'PENDING',
    "source" "KnowledgeSource" NOT NULL DEFAULT 'MANUAL',
    "item_id" TEXT,
    "title" TEXT,
    "text" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "source_ref" TEXT,
    "source_question" TEXT,
    "created_by_id" TEXT,
    "validated_by_id" TEXT,
    "validated_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_kb_org_status" ON "knowledge_items"("organization_id", "status");

-- CreateIndex
CREATE INDEX "idx_kb_org_item" ON "knowledge_items"("organization_id", "item_id");

-- AddForeignKey
ALTER TABLE "knowledge_items" ADD CONSTRAINT "knowledge_items_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Migra os complementos existentes (agent_knowledge_notes) como itens VALIDATED
-- (eles já eram tratados como fatos autoritativos).
INSERT INTO "knowledge_items" (
  "id", "organization_id", "type", "status", "source", "item_id",
  "text", "source_question", "created_by_id", "created_at", "updated_at"
)
SELECT
  "id", "organization_id", 'FACT', 'VALIDATED', 'OPERATOR_COMPLEMENT', "item_id",
  "text", "source_question", "created_by_id", "created_at", "created_at"
FROM "agent_knowledge_notes";
