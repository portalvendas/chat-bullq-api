-- CreateTable
CREATE TABLE "conversation_reads" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "conversation_id" TEXT NOT NULL,
    "last_read_message_id" TEXT,
    "last_read_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "conversation_reads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "conversation_reads_user_id_idx" ON "conversation_reads"("user_id");

-- CreateIndex
CREATE INDEX "conversation_reads_conversation_id_idx" ON "conversation_reads"("conversation_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_reads_user_id_conversation_id_key" ON "conversation_reads"("user_id", "conversation_id");

-- AddForeignKey
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
