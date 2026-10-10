import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';

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
