-- Add per-user, per-organization preferences bag
ALTER TABLE "user_organizations"
ADD COLUMN "preferences" JSONB NOT NULL DEFAULT '{}';
