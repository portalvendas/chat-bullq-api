-- Backfill: telefone canônico (55 + DDD + 9 dígitos) em contacts.phone.
-- Espelha EXATAMENTE src/common/phone.util.ts#canonicalPhone, que a partir
-- deste deploy é aplicado em toda escrita de Contact (extensão do Prisma).
-- Não mexe em contact_channels.external_id (JID real do WhatsApp, que pode
-- ser sem o 9). Sem unique em contacts.phone → não há risco de conflito.
-- Idempotente: rodar de novo não altera nada.
WITH src AS (
  SELECT id, regexp_replace(phone, '\D', '', 'g') AS d
  FROM contacts
  WHERE phone IS NOT NULL
), nat AS (
  SELECT id, d,
         CASE WHEN length(d) > 11 AND d LIKE '55%' THEN substr(d, 3) ELSE d END AS n
  FROM src
), fix9 AS (
  SELECT id, d,
         CASE WHEN length(n) = 10 AND substr(n, 3, 1) ~ '[6-9]'
              THEN left(n, 2) || '9' || substr(n, 3)
              ELSE n END AS n
  FROM nat
), canon AS (
  SELECT id,
         CASE WHEN d = '' THEN NULL
              WHEN length(n) = 11 AND n ~ '^[1-9]{2}9' THEN '55' || n
              ELSE d END AS phone
  FROM fix9
)
UPDATE contacts c
SET phone = canon.phone
FROM canon
WHERE c.id = canon.id
  AND c.phone IS DISTINCT FROM canon.phone;
