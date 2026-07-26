ALTER TABLE "cadences" ADD COLUMN "trigger_type" TEXT NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "cadences" ADD COLUMN "trigger_value" TEXT;
