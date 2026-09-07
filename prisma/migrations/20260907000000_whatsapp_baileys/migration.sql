-- WhatsApp NATIVO (Baileys): novo tipo de canal + tabela de sessão (auth-state).

-- 1) Novo valor no enum ChannelType. PG16 permite ADD VALUE dentro da
--    transação da migration desde que o valor não seja USADO na mesma tx
--    (aqui só criamos a tabela, não inserimos linhas com o novo enum).
ALTER TYPE "ChannelType" ADD VALUE IF NOT EXISTS 'WHATSAPP_BAILEYS';

-- 2) Sessão Baileys por canal (creds + signal keys serializados via BufferJSON).
CREATE TABLE IF NOT EXISTS "whatsapp_baileys_sessions" (
    "id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "creds" JSONB,
    "keys" JSONB,
    "status" TEXT,
    "phone" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "whatsapp_baileys_sessions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "whatsapp_baileys_sessions_channel_id_key"
    ON "whatsapp_baileys_sessions"("channel_id");
