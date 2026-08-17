import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';

/**
 * Cifragem de segredos em repouso (AES-256-GCM) — usada pra proteger os
 * campos sensíveis do canal (`config` com tokens de provider, `webhookSecret`).
 *
 * Envelope (string): `enc:v1:<base64(iv)>:<base64(tag)>:<base64(ciphertext)>`.
 *  - IV de 12 bytes (padrão GCM), tag de 16 bytes.
 *  - Prefixo versionado (`enc:v1:`) permite rotação de algoritmo/formato depois.
 *
 * Regras de segurança/operacionais:
 *  - Chave vem de `process.env.ENCRYPTION_KEY`. Derivamos 32 bytes via SHA-256
 *    da string bruta, então aceita qualquer valor (hex, base64, frase) — mas
 *    TROCAR a string muda a chave e torna os segredos já cifrados ilegíveis.
 *  - Se `ENCRYPTION_KEY` estiver AUSENTE, a cifragem fica DESLIGADA: escreve e
 *    lê em texto puro (comportamento atual). Assim, esquecer a env nunca
 *    "brica" os canais em produção — só não protege até a env ser configurada.
 *  - Descriptografia é tolerante: valor sem envelope `enc:v1:` é tratado como
 *    texto puro legado e devolvido como está. Isso deixa o deploy seguro ANTES
 *    do backfill (linhas antigas continuam legíveis; escritas novas já cifram).
 */

const ENVELOPE_PREFIX = 'enc:v1:';

let cachedKey: Buffer | null | undefined;

function getKey(): Buffer | null {
  if (cachedKey !== undefined) return cachedKey;
  const raw = process.env.ENCRYPTION_KEY;
  if (!raw || !raw.trim()) {
    cachedKey = null;
    return null;
  }
  // SHA-256 garante 32 bytes a partir de qualquer string.
  cachedKey = createHash('sha256').update(raw, 'utf8').digest();
  return cachedKey;
}

/** Só pra testes: limpa o cache da chave após mudar a env. */
export function resetKeyCache(): void {
  cachedKey = undefined;
}

export function isEncryptionEnabled(): boolean {
  return getKey() !== null;
}

export function isEncrypted(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith(ENVELOPE_PREFIX);
}

/** Cifra uma string. Se a chave não existe, devolve o texto puro. */
export function encryptString(plain: string): string {
  const key = getKey();
  if (key === null) return plain;
  if (isEncrypted(plain)) return plain; // idempotente
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plain, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return (
    ENVELOPE_PREFIX +
    iv.toString('base64') +
    ':' +
    tag.toString('base64') +
    ':' +
    ciphertext.toString('base64')
  );
}

/** Decifra uma string. Valor sem envelope é devolvido como está (legado). */
export function decryptString(value: string): string {
  if (!isEncrypted(value)) return value;
  const key = getKey();
  if (key === null) {
    // Env removida depois de cifrar: não temos como decifrar. Não derruba —
    // devolve o envelope pra o chamador perceber (e loga quem chama).
    return value;
  }
  const parts = value.slice(ENVELOPE_PREFIX.length).split(':');
  if (parts.length !== 3) return value;
  const [ivB64, tagB64, dataB64] = parts;
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(data), decipher.final()]);
  return plain.toString('utf8');
}

/* ------------------------------------------------------------------ *
 * Helpers específicos do canal (usados pelo middleware do Prisma).    *
 * ------------------------------------------------------------------ */

/**
 * Marcador do `config` cifrado. Como a coluna é `Json`, guardamos o blob
 * cifrado dentro de um objeto `{ __enc: "enc:v1:..." }` — assim a coluna
 * continua sendo JSON válido e conseguimos detectar o estado na leitura.
 */
const CONFIG_ENC_KEY = '__enc';

function isEncryptedConfig(config: unknown): config is { __enc: string } {
  return (
    typeof config === 'object' &&
    config !== null &&
    !Array.isArray(config) &&
    isEncrypted((config as Record<string, unknown>)[CONFIG_ENC_KEY]) &&
    Object.keys(config as Record<string, unknown>).length === 1
  );
}

/** Cifra o `config` (objeto) → `{ __enc }`. No-op se a chave não existe. */
export function encryptConfig(config: unknown): unknown {
  if (config === null || config === undefined) return config;
  if (!isEncryptionEnabled()) return config;
  if (isEncryptedConfig(config)) return config; // idempotente
  return { [CONFIG_ENC_KEY]: encryptString(JSON.stringify(config)) };
}

/** Decifra `{ __enc }` → objeto original. Config puro (legado) passa direto. */
export function decryptConfig(config: unknown): unknown {
  if (!isEncryptedConfig(config)) return config;
  try {
    const plain = decryptString(config[CONFIG_ENC_KEY]);
    if (isEncrypted(plain)) return config; // não conseguiu decifrar (sem chave)
    return JSON.parse(plain);
  } catch {
    return config;
  }
}

type ChannelWriteData = {
  config?: unknown;
  webhookSecret?: unknown;
  [k: string]: unknown;
};

/**
 * Cifra os campos sensíveis de um `data` de create/update de Channel, sem
 * mutar o objeto original. Ignora updates com operadores Prisma (ex.
 * `{ set: ... }`) que não sejam valor direto — no schema atual o config é
 * sempre passado como valor direto.
 */
export function encryptChannelWriteData<T extends ChannelWriteData>(data: T): T {
  if (!data || typeof data !== 'object' || !isEncryptionEnabled()) return data;
  let out: T = data;
  if ('config' in data && data.config !== undefined && data.config !== null) {
    out = { ...out, config: encryptConfig(data.config) };
  }
  if (
    'webhookSecret' in data &&
    typeof data.webhookSecret === 'string' &&
    data.webhookSecret.length > 0
  ) {
    out = { ...out, webhookSecret: encryptString(data.webhookSecret) };
  }
  return out;
}

/** Decifra os campos sensíveis de UMA linha de Channel vinda do banco. */
export function decryptChannelRow<T extends ChannelWriteData>(row: T): T {
  if (!row || typeof row !== 'object') return row;
  let changed = false;
  let config = row.config;
  let webhookSecret = row.webhookSecret;
  if (isEncryptedConfig(row.config)) {
    config = decryptConfig(row.config);
    changed = true;
  }
  if (isEncrypted(row.webhookSecret)) {
    webhookSecret = decryptString(row.webhookSecret);
    changed = true;
  }
  if (!changed) return row;
  return { ...row, config, webhookSecret };
}

/** Aplica `decryptChannelRow` a uma linha ou array de linhas (ou null). */
export function decryptChannelResult(result: unknown): unknown {
  if (result === null || result === undefined) return result;
  if (Array.isArray(result)) return result.map((r) => decryptChannelRow(r));
  if (typeof result === 'object') return decryptChannelRow(result as ChannelWriteData);
  return result;
}
