-- CreateTable
CREATE TABLE "instagram_comments" (
    "id" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "external_comment_id" TEXT NOT NULL,
    "parent_comment_id" TEXT,
    "from_external_id" TEXT NOT NULL,
    "from_username" TEXT,
    "text" TEXT NOT NULL,
    "media_id" TEXT,
    "media_caption" TEXT,
    "media_permalink" TEXT,
    "media_url" TEXT,
    "media_type" TEXT,
    "ad_id" TEXT,
    "dm_sent" BOOLEAN NOT NULL DEFAULT false,
    "replied_public" BOOLEAN NOT NULL DEFAULT false,
    "converted_card_id" TEXT,
    "contact_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "instagram_comments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "instagram_comments_channel_id_external_comment_id_key" ON "instagram_comments"("channel_id", "external_comment_id");

-- CreateIndex
CREATE INDEX "instagram_comments_organization_id_created_at_idx" ON "instagram_comments"("organization_id", "created_at");

-- AddForeignKey
ALTER TABLE "instagram_comments" ADD CONSTRAINT "instagram_comments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
