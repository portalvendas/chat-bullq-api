-- CreateTable
CREATE TABLE "agent_knowledge_notes" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "item_id" TEXT,
    "text" TEXT NOT NULL,
    "source_question" TEXT,
    "created_by_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_knowledge_notes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_knowledge_org_item" ON "agent_knowledge_notes"("organization_id", "item_id");

-- AddForeignKey
ALTER TABLE "agent_knowledge_notes" ADD CONSTRAINT "agent_knowledge_notes_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
