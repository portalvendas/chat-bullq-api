-- Diretório de organizadores (categoria + largura da gaveta → anúncio MLB).
CREATE TABLE "ml_product_directory" (
  "id" TEXT NOT NULL,
  "organization_id" TEXT NOT NULL,
  "categoria" TEXT NOT NULL,
  "largura_cm" INTEGER NOT NULL,
  "codigo" TEXT,
  "mlb" TEXT NOT NULL,
  "url" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ml_product_directory_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "uq_mldir_org_cat_width" ON "ml_product_directory"("organization_id","categoria","largura_cm");
CREATE INDEX "idx_mldir_org_cat" ON "ml_product_directory"("organization_id","categoria");
ALTER TABLE "ml_product_directory" ADD CONSTRAINT "ml_product_directory_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
