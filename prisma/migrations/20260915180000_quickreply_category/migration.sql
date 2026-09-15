-- Respostas rápidas: campo TIPO/categoria (texto livre) p/ agrupar nas telas.
-- Nullable — respostas antigas ficam sem tipo ("Sem tipo" no front).
ALTER TABLE "quick_replies" ADD COLUMN "category" TEXT;
