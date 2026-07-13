-- Modo revisão: respostas da IA ficam pendentes de aprovação humana.
ALTER TABLE "organizations" ADD COLUMN "ai_review_mode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "conversations" ADD COLUMN "ai_review_mode" BOOLEAN;
