-- AlterEnum
ALTER TYPE "AiToolSource" ADD VALUE 'CUSTOM_SQL';

-- AlterTable
ALTER TABLE "ai_tools" ADD COLUMN     "sql_connection_ref" TEXT,
ADD COLUMN     "sql_max_rows" INTEGER NOT NULL DEFAULT 50,
ADD COLUMN     "sql_param_map" JSONB,
ADD COLUMN     "sql_query" TEXT,
ADD COLUMN     "sql_read_only" BOOLEAN NOT NULL DEFAULT true;
