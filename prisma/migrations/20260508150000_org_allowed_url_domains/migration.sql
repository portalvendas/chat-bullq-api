-- ============================================================================
-- URL whitelist por organização
-- ============================================================================
-- IA inventando URLs (hallucination) é um padrão difícil de eliminar só
-- com prompt — o LLM gera links plausíveis tipo "alunos.bravy.co" mesmo
-- quando o domínio real é outro. Visto em prod (Daniel Souza/Gabriel
-- Alberton, 2026-05-08 20:39).
--
-- Solução: campo `allowed_url_domains` (JSON array de strings) na org.
-- Quando preenchido, runtime guard rejeita qualquer URL no reply cujo
-- host não esteja na lista. NULL/vazio = permissivo (só warning).
-- ============================================================================

ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "allowed_url_domains" JSONB;
