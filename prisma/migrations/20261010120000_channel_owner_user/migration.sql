-- Vendedor dono do número (canal). Usado na distribuição de leads: lead que
-- entra por este número é atribuído a ele antes do sorteio ponderado.
ALTER TABLE "channels"
  ADD COLUMN "owner_user_id" TEXT;
