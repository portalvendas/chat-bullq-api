-- Comissões por vendedor (só OWNER) + frete do pedido (base da comissão sem frete).

ALTER TABLE "tiny_documents"
  ADD COLUMN IF NOT EXISTS "valor_frete" DECIMAL(14,2),
  ADD COLUMN IF NOT EXISTS "frete_checked_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "frete_valor_ref" DECIMAL(14,2);

CREATE TABLE IF NOT EXISTS "commission_plans" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "vendedor" TEXT NOT NULL,
  "user_id" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "fixed_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "goal_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  "percent" DECIMAL(6,3) NOT NULL DEFAULT 0,
  "percent_base" TEXT NOT NULL DEFAULT 'EXCEDENTE',
  "keep_fixed" BOOLEAN NOT NULL DEFAULT true,
  "notes" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "commission_plans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "commission_plans_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_commission_plan_org_vendedor"
  ON "commission_plans"("organization_id", "vendedor");

CREATE TABLE IF NOT EXISTS "commission_goals" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "vendedor" TEXT NOT NULL,
  "month" TEXT NOT NULL,
  "goal_amount" DECIMAL(14,2) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "commission_goals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "commission_goals_organization_id_fkey" FOREIGN KEY ("organization_id")
    REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "uq_commission_goal_org_vend_month"
  ON "commission_goals"("organization_id", "vendedor", "month");
