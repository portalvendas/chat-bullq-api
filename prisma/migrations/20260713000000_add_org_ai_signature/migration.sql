-- Assinatura fixa anexada ao final de toda resposta da IA.
ALTER TABLE "organizations" ADD COLUMN "ai_signature" TEXT;

-- Seed do valor solicitado para as orgs existentes (novas orgs = NULL).
UPDATE "organizations"
  SET "ai_signature" = 'Aguardamos sua compra e ficamos à disposição, Armazém Decora.'
  WHERE "ai_signature" IS NULL;
