-- Filtros da tela de Pedidos: marketplace (origem) e natureza da operação.
ALTER TABLE "tiny_documents" ADD COLUMN "is_marketplace" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "tiny_documents" ADD COLUMN "natureza" TEXT;
ALTER TABLE "tiny_documents" ADD COLUMN "vendedor" TEXT;

-- Backfill do vendedor a partir do payload cru (pedidos trazem vendedor na
-- listagem; orçamentos não — ficam null e são preenchidos pelo enriquecimento).
UPDATE "tiny_documents"
SET "vendedor" = NULLIF("raw"->'vendedor'->>'nome', '')
WHERE "kind" = 'PEDIDO' AND "raw"->'vendedor'->>'nome' IS NOT NULL;

-- Backfill de is_marketplace a partir do payload cru já armazenado (sem API):
-- marca true quando a origem (ecommerce.nome/canalVenda) é um marketplace.
UPDATE "tiny_documents"
SET "is_marketplace" = true
WHERE "kind" = 'PEDIDO'
  AND (
    COALESCE("raw"->'ecommerce'->>'nome', '') || ' ' ||
    COALESCE("raw"->'ecommerce'->>'canalVenda', '')
  ) ~* '(mercado ?livre|shopee|magalu|magazine ?luiza|amazon|americanas|b2w|via ?varejo)';

-- Índice pra acelerar a listagem filtrada (tipo + situação + marketplace).
CREATE INDEX "idx_tinydoc_org_kind_situacao" ON "tiny_documents"("organization_id", "kind", "situacao");
