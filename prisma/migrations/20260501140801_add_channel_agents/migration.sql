-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "reopened_at" TIMESTAMP(3),
ADD COLUMN     "reopened_count" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "channel_agents" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "user_organization_id" TEXT NOT NULL,
    "granted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "granted_by_id" TEXT,

    CONSTRAINT "channel_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_ratings" (
    "id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "score" INTEGER NOT NULL,
    "comment" TEXT,
    "token" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_ratings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_channel_agent_userorg" ON "channel_agents"("user_organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "channel_agents_channel_id_user_organization_id_key" ON "channel_agents"("channel_id", "user_organization_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_ratings_conversation_id_key" ON "conversation_ratings"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_ratings_token_key" ON "conversation_ratings"("token");

-- CreateIndex
CREATE INDEX "idx_rating_org_responded" ON "conversation_ratings"("organization_id", "responded_at");

-- CreateIndex
CREATE INDEX "idx_rating_org_agent" ON "conversation_ratings"("organization_id", "agent_id");

-- AddForeignKey
ALTER TABLE "channel_agents" ADD CONSTRAINT "channel_agents_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "channel_agents" ADD CONSTRAINT "channel_agents_user_organization_id_fkey" FOREIGN KEY ("user_organization_id") REFERENCES "user_organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_ratings" ADD CONSTRAINT "conversation_ratings_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "uq_msg_conv_external" RENAME TO "messages_conversation_id_external_id_key";

-- Backfill: every existing AGENT gets access to every existing channel in their org.
-- Without this, deploying deny-by-default RBAC would silently revoke all agents.
INSERT INTO "channel_agents" ("id", "channel_id", "user_organization_id", "granted_at")
SELECT
  'cag_' || replace(gen_random_uuid()::text, '-', ''),
  c."id",
  uo."id",
  NOW()
FROM "channels" c
JOIN "user_organizations" uo ON uo."organization_id" = c."organization_id"
WHERE uo."role" = 'AGENT'
  AND c."deleted_at" IS NULL
ON CONFLICT ("channel_id", "user_organization_id") DO NOTHING;
