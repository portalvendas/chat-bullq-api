-- Trava de follow-up por canal. true = o número não dispara follow-up
-- (cadências/Salesbots). Default false mantém o comportamento atual.
ALTER TABLE "channels"
  ADD COLUMN "follow_up_blocked" BOOLEAN NOT NULL DEFAULT false;
