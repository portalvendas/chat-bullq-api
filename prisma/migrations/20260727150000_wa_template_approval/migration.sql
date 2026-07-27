-- Tracking de submissão/aprovação de templates na Meta.
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "meta_name" TEXT;
ALTER TABLE "whatsapp_templates" ADD COLUMN IF NOT EXISTS "rejection_reason" TEXT;
