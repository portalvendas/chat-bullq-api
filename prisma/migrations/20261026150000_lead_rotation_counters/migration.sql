-- Distribuição por RODÍZIO estrito (sem sorteio): contador atômico por funil.
-- Com 50/50 a sequência é 1 lead para cada vendedora, alternando.
CREATE TABLE IF NOT EXISTS "lead_rotation_counters" (
  "organization_id" TEXT NOT NULL,
  "pipeline_key" TEXT NOT NULL,
  "counter" BIGINT NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "lead_rotation_counters_pkey" PRIMARY KEY ("organization_id", "pipeline_key")
);
ALTER TABLE "lead_rotation_counters" ADD CONSTRAINT "lead_rotation_counters_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
