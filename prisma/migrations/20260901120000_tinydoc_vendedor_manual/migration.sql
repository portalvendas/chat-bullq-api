-- Vendedor definido manualmente na tela (não sobrescrito pelo sync do Tiny).
ALTER TABLE "tiny_documents" ADD COLUMN IF NOT EXISTS "vendedor_manual" BOOLEAN NOT NULL DEFAULT false;
