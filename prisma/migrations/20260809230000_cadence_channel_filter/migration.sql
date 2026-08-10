-- Filtro de ORIGEM do Salesbot: lista de channelIds em que o bot pode disparar.
-- Vazio ('[]') = dispara para todas as origens (comportamento atual).
ALTER TABLE "cadences" ADD COLUMN IF NOT EXISTS "channel_filter" JSONB NOT NULL DEFAULT '[]';
