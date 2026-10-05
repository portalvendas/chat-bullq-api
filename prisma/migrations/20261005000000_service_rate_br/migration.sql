-- Corrige a tarifa de SERVICE (BR): estava zerada, então o excedente de
-- mensagens de serviço acima da franquia de 1.000/número/mês (mudança Meta
-- out/2026) aparecia R$ 0,00 e subestimava o custo real.
-- ~US$ 0,0068 ≈ R$ 0,036 → 36000 micros. Ajuste conforme o repasse real da Meta.
-- Nota: só vale para mensagens capturadas DAQUI PRA FRENTE (o custo é gravado no
-- momento do webhook). O histórico já registrado não é recalculado.
UPDATE "message_pricing"
SET "amount_micros" = 36000
WHERE "country_code" = 'BR' AND "category" = 'SERVICE';

-- Se por acaso não existir a linha de SERVICE (instalações antigas), cria.
INSERT INTO "message_pricing" ("id", "country_code", "category", "amount_micros", "currency", "effective_from", "source", "created_at")
SELECT gen_random_uuid()::text, 'BR', 'SERVICE', 36000, 'BRL', CURRENT_TIMESTAMP, 'meta-out2026', CURRENT_TIMESTAMP
WHERE NOT EXISTS (
  SELECT 1 FROM "message_pricing" WHERE "country_code" = 'BR' AND "category" = 'SERVICE'
);
