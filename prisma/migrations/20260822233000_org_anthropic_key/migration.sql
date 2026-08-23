-- BYOK: chave da API do Claude (Anthropic) por empresa, cifrada em repouso.
ALTER TABLE "organizations" ADD COLUMN "ai_anthropic_key_enc" TEXT;
