-- Comissão = Produtos (valor líquido, após desconto) − Frete.
ALTER TABLE "tiny_documents" ADD COLUMN IF NOT EXISTS "valor_produtos" DECIMAL(14,2);
-- O valor_frete gravado antes somava "outras despesas": força reler tudo do Tiny.
UPDATE "tiny_documents" SET "frete_checked_at" = NULL WHERE "frete_checked_at" IS NOT NULL;
