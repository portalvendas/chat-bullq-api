-- Refactor skills/tools: Tools are now connection providers, Skills are LLM-callable functions.

-- Drop old structures
DROP TABLE IF EXISTS "ai_skill_tools" CASCADE;
DROP TABLE IF EXISTS "ai_agent_tools" CASCADE;

-- Drop old columns from ai_tools (we'll recreate cleanly)
ALTER TABLE "ai_tools"
  DROP COLUMN IF EXISTS "parameters",
  DROP COLUMN IF EXISTS "http_method",
  DROP COLUMN IF EXISTS "http_url",
  DROP COLUMN IF EXISTS "http_body_template",
  DROP COLUMN IF EXISTS "response_map",
  DROP COLUMN IF EXISTS "sql_query",
  DROP COLUMN IF EXISTS "sql_param_map",
  DROP COLUMN IF EXISTS "sql_read_only",
  DROP COLUMN IF EXISTS "sql_max_rows",
  DROP COLUMN IF EXISTS "timeout_ms";

-- Add http_base_url to ai_tools
ALTER TABLE "ai_tools" ADD COLUMN IF NOT EXISTS "http_base_url" TEXT;

-- ai_tools.organization_id agora é NOT NULL (built-in não vive aqui mais)
ALTER TABLE "ai_tools" ALTER COLUMN "organization_id" SET NOT NULL;

-- Remove BUILTIN do enum AiToolSource
ALTER TYPE "AiToolSource" RENAME TO "AiToolSource_old";
CREATE TYPE "AiToolSource" AS ENUM ('CUSTOM_HTTP', 'CUSTOM_SQL');
ALTER TABLE "ai_tools" ALTER COLUMN "source" TYPE "AiToolSource" USING "source"::text::"AiToolSource";
DROP TYPE "AiToolSource_old";

-- Novo enum AiSkillSource
CREATE TYPE "AiSkillSource" AS ENUM ('BUILTIN', 'HTTP', 'SQL');

-- Adiciona campos novos em ai_skills
ALTER TABLE "ai_skills"
  ADD COLUMN IF NOT EXISTS "source" "AiSkillSource" NOT NULL DEFAULT 'HTTP',
  ADD COLUMN IF NOT EXISTS "parameters" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "tool_id" TEXT,
  ADD COLUMN IF NOT EXISTS "http_method" TEXT,
  ADD COLUMN IF NOT EXISTS "http_path" TEXT,
  ADD COLUMN IF NOT EXISTS "http_headers_extra" JSONB,
  ADD COLUMN IF NOT EXISTS "http_body_template" TEXT,
  ADD COLUMN IF NOT EXISTS "response_map" JSONB,
  ADD COLUMN IF NOT EXISTS "sql_query" TEXT,
  ADD COLUMN IF NOT EXISTS "sql_param_map" JSONB,
  ADD COLUMN IF NOT EXISTS "sql_read_only" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "sql_max_rows" INTEGER NOT NULL DEFAULT 50,
  ADD COLUMN IF NOT EXISTS "timeout_ms" INTEGER NOT NULL DEFAULT 15000;

-- FK skill → tool
ALTER TABLE "ai_skills"
  ADD CONSTRAINT "ai_skills_tool_id_fkey"
  FOREIGN KEY ("tool_id") REFERENCES "ai_tools"("id") ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS "idx_skill_tool" ON "ai_skills"("tool_id");

-- Expandir snapshot da version pra carregar tudo
ALTER TABLE "ai_skill_versions"
  ADD COLUMN IF NOT EXISTS "source" "AiSkillSource",
  ADD COLUMN IF NOT EXISTS "parameters" JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "tool_id" TEXT,
  ADD COLUMN IF NOT EXISTS "http_method" TEXT,
  ADD COLUMN IF NOT EXISTS "http_path" TEXT,
  ADD COLUMN IF NOT EXISTS "http_headers_extra" JSONB,
  ADD COLUMN IF NOT EXISTS "http_body_template" TEXT,
  ADD COLUMN IF NOT EXISTS "response_map" JSONB,
  ADD COLUMN IF NOT EXISTS "sql_query" TEXT,
  ADD COLUMN IF NOT EXISTS "sql_param_map" JSONB,
  ADD COLUMN IF NOT EXISTS "sql_read_only" BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS "sql_max_rows" INTEGER DEFAULT 50,
  ADD COLUMN IF NOT EXISTS "timeout_ms" INTEGER DEFAULT 15000;

-- toolIds antigo da version: redundante agora (snapshot tem tool_id direto)
ALTER TABLE "ai_skill_versions" DROP COLUMN IF EXISTS "tool_ids";
