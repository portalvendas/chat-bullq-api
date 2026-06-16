-- ============================================================================
-- Message revoke (delete for everyone)
-- ============================================================================
-- Adiciona estado de "mensagem deletada pra todos" no Message. Operadores
-- usam pra remover mensagens enviadas pelo bot/humano que não deveriam ter
-- ido (ex: prompt injection, vazamento, erro de conteúdo).
--
-- Comportamento por canal (provider-side):
--   - Zappfy/Uazapi  : suporta `/message/delete` → mensagem some no app do cliente
--   - WhatsApp Cloud : Meta NÃO expõe delete na API → soft-delete só no nosso lado
--   - Instagram      : idem — só soft-delete local
--
-- Mantemos a row do Message intacta (não deletamos do banco) pra preservar
-- histórico/auditoria. UI renderiza "🚫 Mensagem deletada".
-- ============================================================================

ALTER TABLE "messages"
  ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "revoked_by" TEXT,
  ADD COLUMN IF NOT EXISTS "revoke_succeeded_remote" BOOLEAN;

-- FK opcional pro user que clicou em deletar. SET NULL pra preservar
-- registro de revoke mesmo se o user for deletado depois.
DO $$ BEGIN
  ALTER TABLE "messages"
    ADD CONSTRAINT "messages_revoked_by_fkey"
    FOREIGN KEY ("revoked_by") REFERENCES "users"("id") ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN null; END $$;
