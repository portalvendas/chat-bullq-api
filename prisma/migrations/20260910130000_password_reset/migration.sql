-- Recuperação de senha: tokens de uso único (guardados só como hash SHA-256),
-- com expiração curta. password_changed_at invalida sessões/JWTs antigos.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "password_changed_at" TIMESTAMP(3);

CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
  "id"           TEXT NOT NULL,
  "user_id"      TEXT NOT NULL,
  "token_hash"   TEXT NOT NULL,
  "expires_at"   TIMESTAMP(3) NOT NULL,
  "used_at"      TIMESTAMP(3),
  "requested_ip" TEXT,
  "created_at"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_token_hash_key"
  ON "password_reset_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "idx_password_reset_user"
  ON "password_reset_tokens" ("user_id");

ALTER TABLE "password_reset_tokens"
  ADD CONSTRAINT "password_reset_tokens_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
