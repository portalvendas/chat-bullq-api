-- CreateEnum
CREATE TYPE "ChannelSyncStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ChannelSyncMode" AS ENUM ('INITIAL', 'MANUAL', 'DELTA');

-- CreateTable
CREATE TABLE "channel_sync_jobs" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "status" "ChannelSyncStatus" NOT NULL DEFAULT 'PENDING',
    "mode" "ChannelSyncMode" NOT NULL DEFAULT 'INITIAL',
    "lookback_days" INTEGER NOT NULL DEFAULT 90,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "conversations_total" INTEGER NOT NULL DEFAULT 0,
    "conversations_imported" INTEGER NOT NULL DEFAULT 0,
    "messages_imported" INTEGER NOT NULL DEFAULT 0,
    "contacts_imported" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "last_cursor" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "channel_sync_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_sync_channel_time" ON "channel_sync_jobs"("channel_id", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_sync_status" ON "channel_sync_jobs"("status");

-- AddForeignKey
ALTER TABLE "channel_sync_jobs" ADD CONSTRAINT "channel_sync_jobs_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
