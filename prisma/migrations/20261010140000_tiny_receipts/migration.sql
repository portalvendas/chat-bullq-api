-- Comprovantes de pagamento por pedido (vários por pedido). Dados extraídos
-- por IA e editáveis; tabela própria pra o sync do Tiny não sobrescrever.
CREATE TABLE "tiny_receipts" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "tiny_document_id" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "mime_type" TEXT,
  "file_name" TEXT,
  "valor" DECIMAL(14,2),
  "metodo" TEXT,
  "parcelas" INTEGER,
  "data_pagamento" TIMESTAMP(3),
  "eh_comprovante" BOOLEAN,
  "status_extracao" TEXT,
  "observacao" TEXT,
  "extraido_em" TIMESTAMP(3),
  "uploaded_by_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "tiny_receipts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_tinyreceipt_doc" ON "tiny_receipts"("tiny_document_id");
CREATE INDEX "idx_tinyreceipt_org" ON "tiny_receipts"("organization_id");

ALTER TABLE "tiny_receipts"
  ADD CONSTRAINT "tiny_receipts_tiny_document_id_fkey"
  FOREIGN KEY ("tiny_document_id") REFERENCES "tiny_documents"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
