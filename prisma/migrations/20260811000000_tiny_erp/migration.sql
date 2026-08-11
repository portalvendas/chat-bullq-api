-- TinyIntegration: conexão OAuth com o ERP Olist Tiny (uma por organização)
CREATE TABLE "tiny_integrations" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "access_token" TEXT,
  "refresh_token" TEXT,
  "token_expires_at" TIMESTAMP(3),
  "refresh_expires_at" TIMESTAMP(3),
  "account_name" TEXT,
  "last_pedidos_sync_at" TIMESTAMP(3),
  "last_orcamentos_sync_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tiny_integrations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "tiny_integrations_organization_id_key" ON "tiny_integrations"("organization_id");

ALTER TABLE "tiny_integrations"
  ADD CONSTRAINT "tiny_integrations_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- TinyDocument: pedido/orçamento do Tiny vinculado (quando casa) a um Contact
CREATE TABLE "tiny_documents" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "tiny_id" TEXT NOT NULL,
  "numero" TEXT,
  "situacao" TEXT,
  "data" TIMESTAMP(3),
  "valor" DECIMAL(14,2),
  "cliente_nome" TEXT,
  "cliente_cpf_cnpj" TEXT,
  "cliente_telefone" TEXT,
  "cliente_email" TEXT,
  "tiny_contato_id" TEXT,
  "contact_id" TEXT,
  "matched_by" TEXT,
  "raw" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tiny_documents_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "uq_tinydoc_org_kind_tinyid" ON "tiny_documents"("organization_id", "kind", "tiny_id");
CREATE INDEX "idx_tinydoc_org_contact" ON "tiny_documents"("organization_id", "contact_id");
CREATE INDEX "idx_tinydoc_org_kind" ON "tiny_documents"("organization_id", "kind");

ALTER TABLE "tiny_documents"
  ADD CONSTRAINT "tiny_documents_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tiny_documents"
  ADD CONSTRAINT "tiny_documents_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
