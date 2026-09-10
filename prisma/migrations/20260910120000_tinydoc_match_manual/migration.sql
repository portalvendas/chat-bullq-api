-- Vínculo de lead definido manualmente na tela (o sync do Tiny NÃO sobrescreve).
ALTER TABLE "tiny_documents" ADD COLUMN IF NOT EXISTS "match_manual" BOOLEAN NOT NULL DEFAULT false;
