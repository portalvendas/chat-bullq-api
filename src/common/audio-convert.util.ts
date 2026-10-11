import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import axios from 'axios';

const execFileAsync = promisify(execFile);

/**
 * Converte um buffer de áudio (ex.: OGG/Opus) para MP3 via ffmpeg, usando
 * arquivos temporários. Usado no envio de áudio: WhatsApp (Cloud API e Baileys)
 * não reproduz OGG/Opus de forma confiável no destino ("áudio não está mais
 * disponível"); MP3 toca em qualquer cliente.
 */
export async function audioBufferToMp3(buffer: Buffer): Promise<Buffer> {
  const id = crypto.randomBytes(8).toString('hex');
  const src = path.join(os.tmpdir(), `wa-${id}.in`);
  const out = path.join(os.tmpdir(), `wa-${id}.mp3`);
  await fs.promises.writeFile(src, buffer);
  try {
    await execFileAsync(
      'ffmpeg',
      [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-i', src,
        '-vn',
        '-c:a', 'libmp3lame',
        '-b:a', '64k',
        '-ac', '1',
        '-ar', '44100',
        out,
      ],
      { timeout: 30_000 },
    );
    return await fs.promises.readFile(out);
  } finally {
    fs.promises.unlink(src).catch(() => undefined);
    fs.promises.unlink(out).catch(() => undefined);
  }
}

/** Baixa os bytes de uma mediaUrl pública (HTTP GET arraybuffer). */
export async function fetchBytes(url: string): Promise<Buffer> {
  const r = await axios.get<ArrayBuffer>(url, {
    responseType: 'arraybuffer',
    timeout: 60000,
  });
  return Buffer.from(r.data);
}

/** Converte um Buffer MP3 num data URI (`data:audio/mpeg;base64,...`). */
export function mp3DataUri(buffer: Buffer): string {
  return `data:audio/mpeg;base64,${buffer.toString('base64')}`;
}

/**
 * Para provedores que mandam mídia por URL/base64 (Z-API, Zappfy): quando o
 * áudio é OGG/Opus (não toca no destino), baixa, converte p/ MP3 e troca o
 * `content.mediaUrl` por um data URI MP3 + `content.mimeType='audio/mpeg'`
 * (in place). Best-effort: se falhar, deixa o OGG. Retorna true se converteu.
 */
export async function convertOutboundAudioToMp3DataUri(
  content: Record<string, any> | undefined,
  logger?: { warn: (m: string) => void },
): Promise<boolean> {
  if (!content?.mediaUrl) return false;
  if (!String(content.mimeType || '').includes('ogg')) return false;
  try {
    const raw = await fetchBytes(content.mediaUrl);
    const mp3 = await audioBufferToMp3(raw);
    content.mediaUrl = mp3DataUri(mp3);
    content.mimeType = 'audio/mpeg';
    return true;
  } catch (e: any) {
    logger?.warn?.(`audio ogg->mp3 falhou: ${e?.message ?? e}`);
    return false;
  }
}
