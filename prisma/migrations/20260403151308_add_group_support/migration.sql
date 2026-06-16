-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "is_group" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "messages" ADD COLUMN     "sender_name" TEXT;
