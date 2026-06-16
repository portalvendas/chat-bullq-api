-- CreateEnum
CREATE TYPE "WebhookEventStatus" AS ENUM ('RECEIVED', 'PROCESSED', 'FAILED', 'UNROUTED');

-- AlterTable Conversation: add soft-delete flag
ALTER TABLE "conversations" ADD COLUMN "deleted_at" TIMESTAMP(3);

-- CreateTable webhook_events (append-only source-of-truth for provider webhooks)
CREATE TABLE "webhook_events" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT,
    "channel_type" "ChannelType" NOT NULL,
    "status" "WebhookEventStatus" NOT NULL DEFAULT 'RECEIVED',
    "raw_payload" JSONB NOT NULL,
    "headers" JSONB NOT NULL DEFAULT '{}',
    "error_message" TEXT,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at" TIMESTAMP(3),

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "idx_webhook_channel_time" ON "webhook_events"("channel_id", "received_at" DESC);

-- CreateIndex
CREATE INDEX "idx_webhook_type_status" ON "webhook_events"("channel_type", "status", "received_at" DESC);
