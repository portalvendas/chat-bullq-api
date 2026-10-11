-- Chave da OpenAI por empresa (BYOK), cifrada em repouso. Usada na transcrição
-- de áudio (Whisper). NULL = usa a env global OPENAI_API_KEY (se houver).
ALTER TABLE "organizations" ADD COLUMN "ai_openai_key_enc" TEXT;
