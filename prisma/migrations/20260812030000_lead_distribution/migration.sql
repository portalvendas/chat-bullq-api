-- Orquestrador de leads: config de distribuição ponderada por vendedor.
CREATE TABLE "lead_distribution_configs" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "weights" JSONB NOT NULL DEFAULT '[]',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "lead_distribution_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "lead_distribution_configs_organization_id_key" ON "lead_distribution_configs"("organization_id");

ALTER TABLE "lead_distribution_configs"
  ADD CONSTRAINT "lead_distribution_configs_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
