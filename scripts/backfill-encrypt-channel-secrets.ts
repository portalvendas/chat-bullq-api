/**
 * Backfill: cifra em repouso os segredos dos canais já existentes
 * (`Channel.config` com tokens de provider e `Channel.webhookSecret`),
 * usando o mesmo envelope AES-256-GCM do runtime (src/common/crypto).
 *
 * Como funciona:
 *  - Usa um PrismaClient CRU (sem o middleware do app), então lê o valor
 *    exatamente como está gravado no banco e escreve exatamente o que
 *    mandarmos — evitando dupla cifragem.
 *  - Idempotente: pula campos que já estão cifrados (config com `__enc`,
 *    webhookSecret com prefixo `enc:v1:`). Pode rodar quantas vezes quiser.
 *  - Seguro p/ rodar DEPOIS do deploy do middleware: linhas novas já nascem
 *    cifradas; este script só converte as linhas antigas (texto puro).
 *
 * Pré-requisito: ENCRYPTION_KEY definido no ambiente (a MESMA chave do app).
 * Sem ela, o script ABORTA (não faz no-op silencioso).
 *
 * Uso:
 *   cd chat-bullq-api
 *   # conferência, sem gravar:
 *   ENCRYPTION_KEY=... npx ts-node -P tsconfig.json --transpile-only scripts/backfill-encrypt-channel-secrets.ts --dry-run
 *   # aplicar:
 *   ENCRYPTION_KEY=... npx ts-node -P tsconfig.json --transpile-only scripts/backfill-encrypt-channel-secrets.ts
 */
import { PrismaClient } from '@prisma/client';
import {
  isEncryptionEnabled,
  isEncrypted,
  encryptConfig,
  encryptString,
  decryptChannelRow,
} from '../src/common/crypto/secret-cipher';

const prisma = new PrismaClient();
const DRY_RUN = process.argv.includes('--dry-run');

function configAlreadyEncrypted(config: unknown): boolean {
  return (
    typeof config === 'object' &&
    config !== null &&
    !Array.isArray(config) &&
    isEncrypted((config as Record<string, unknown>).__enc) &&
    Object.keys(config as Record<string, unknown>).length === 1
  );
}

async function main() {
  if (!isEncryptionEnabled()) {
    console.error(
      'ERRO: ENCRYPTION_KEY não definido. Defina a MESMA chave do app e rode de novo.',
    );
    process.exit(1);
  }

  // PrismaClient cru: sem middleware → valores exatamente como no banco.
  const channels = await prisma.channel.findMany({
    select: { id: true, name: true, config: true, webhookSecret: true },
  });
  console.log(
    `${channels.length} canais no total. ${DRY_RUN ? '(DRY-RUN — nada será gravado)' : ''}`,
  );

  let cfgEnc = 0;
  let secEnc = 0;
  let skipped = 0;

  for (const ch of channels) {
    const data: { config?: unknown; webhookSecret?: string } = {};

    if (ch.config !== null && !configAlreadyEncrypted(ch.config)) {
      data.config = encryptConfig(ch.config);
      cfgEnc++;
    }
    if (
      typeof ch.webhookSecret === 'string' &&
      ch.webhookSecret.length > 0 &&
      !isEncrypted(ch.webhookSecret)
    ) {
      data.webhookSecret = encryptString(ch.webhookSecret);
      secEnc++;
    }

    if (Object.keys(data).length === 0) {
      skipped++;
      continue;
    }

    if (DRY_RUN) {
      console.log(
        `  [dry] ${ch.id} (${ch.name}) → cifraria: ${Object.keys(data).join(', ')}`,
      );
      continue;
    }

    await prisma.channel.update({ where: { id: ch.id }, data });
    console.log(
      `  ok ${ch.id} (${ch.name}) → cifrado: ${Object.keys(data).join(', ')}`,
    );
  }

  console.log(
    `\nResumo: config cifrados=${cfgEnc}, webhookSecret cifrados=${secEnc}, já ok/pulados=${skipped}.`,
  );

  // Verificação: relê e decifra as linhas afetadas pra garantir round-trip.
  if (!DRY_RUN && (cfgEnc > 0 || secEnc > 0)) {
    const check = await prisma.channel.findMany({
      select: { id: true, config: true, webhookSecret: true },
    });
    let bad = 0;
    for (const ch of check) {
      const dec = decryptChannelRow(ch as any);
      if (isEncrypted((dec as any).webhookSecret)) bad++;
      const c = (dec as any).config;
      if (c && typeof c === 'object' && '__enc' in c) bad++;
    }
    console.log(
      bad === 0
        ? 'Verificação: todas as linhas decifram corretamente. ✅'
        : `Verificação: ${bad} campo(s) NÃO decifram — investigar (chave errada?). ❌`,
    );
    if (bad > 0) process.exit(2);
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
