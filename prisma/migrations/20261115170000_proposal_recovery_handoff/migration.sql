ALTER TABLE "proposal_recoveries" ADD COLUMN IF NOT EXISTS "handed_off_at" TIMESTAMP(3);
ALTER TABLE "proposal_recoveries" ADD COLUMN IF NOT EXISTS "handoff_alerted_at" TIMESTAMP(3);
