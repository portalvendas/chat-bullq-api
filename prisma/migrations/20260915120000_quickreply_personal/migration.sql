-- Respostas rápidas: escopo PESSOAL (user_id). null = compartilhada (empresa).
ALTER TABLE "quick_replies" ADD COLUMN "user_id" TEXT;

-- Unicidade de atalho passa a ser por escopo (validada no service), então
-- solta o unique global de atalho por org.
DROP INDEX IF EXISTS "quick_replies_organization_id_shortcut_key";

CREATE INDEX "idx_quickreply_org_user" ON "quick_replies"("organization_id", "user_id");

ALTER TABLE "quick_replies"
  ADD CONSTRAINT "quick_replies_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
