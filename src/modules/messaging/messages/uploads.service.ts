import {
  Injectable,
  BadRequestException,
  ServiceUnavailableException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

const execFileAsync = promisify(execFile);

export interface UploadResult {
  url: string;
  mimeType: string;
  size: number;
  filename: string;
}

/**
 * Stores user-uploaded media (agent recordings) and inbound media we
 * mirror locally (e.g., WhatsApp Cloud requires a Bearer token to
 * download — browsers can't load it directly, so we re-host it here).
 *
 * Files are written under `uploads/` and served publicly through
 * `/api/v1/uploads/*`. Swap with S3/R2 when we go multi-instance — the
 * public URL contract stays the same.
 */
@Injectable()
export class UploadsService {
  private readonly logger = new Logger(UploadsService.name);

  // 25MB matches OpenAI Whisper's upload cap, so audios we accept are also
  // transcribable without chunking.
  static readonly MAX_AUDIO_BYTES = 25 * 1024 * 1024;

  // 64MB upper bound for any inbound media we mirror. WhatsApp Cloud caps
  // documents at 100MB but most chat content is well under this — bigger
  // files we'd want to stream rather than buffer in memory anyway.
  static readonly MAX_INBOUND_BYTES = 64 * 1024 * 1024;

  private static readonly ALLOWED_AUDIO_MIME = new Set([
    'audio/mpeg',
    'audio/mp4',
    'audio/m4a',
    'audio/ogg',
    'audio/wav',
    'audio/webm',
    'audio/webm;codecs=opus',
  ]);

  // 64MB: acima do cap de vídeo do WhatsApp (16MB) e de imagem (5MB) — o
  // provider rejeita o que não aceitar; aqui só barramos abusos óbvios.
  static readonly MAX_MEDIA_BYTES = 64 * 1024 * 1024;

  private static readonly ALLOWED_MEDIA_MIME = new Set([
    // image
    'image/jpeg',
    'image/jpg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/heic',
    // video
    'video/mp4',
    'video/quicktime',
    'video/3gpp',
    'video/webm',
    // document
    'application/pdf',
    'application/zip',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'text/plain',
    'text/csv',
  ]);

  private readonly rootDir: string;
  private readonly publicBaseUrl: string;
  /** Dias de retenção de mídia no disco (0 = nunca poda). Env UPLOADS_RETENTION_DAYS. */
  private readonly retentionDays: number;

  constructor(private readonly config: ConfigService) {
    this.rootDir = path.resolve(
      this.config.get<string>('UPLOADS_DIR') ||
        path.join(process.cwd(), 'uploads'),
    );
    const appUrl = this.config.get<string>('APP_URL') || '';
    this.publicBaseUrl = `${appUrl.replace(/\/$/, '')}/api/v1/uploads`;
    this.retentionDays =
      Number(this.config.get<string>('UPLOADS_RETENTION_DAYS')) || 45;
    if (!fs.existsSync(this.rootDir)) {
      fs.mkdirSync(this.rootDir, { recursive: true });
    }
  }

  /**
   * Persists an inbound media buffer (any type — image, video, audio,
   * document, sticker) under a per-channel/per-day folder and returns a
   * playable public URL. Used by adapters whose providers deliver media
   * gated behind auth (WhatsApp Cloud) or via short-lived signed URLs we
   * don't want to depend on.
   *
   * `originalFilename` is preserved when the provider gives one (typical
   * for documents) — useful for the UI to render a familiar filename and
   * for the browser's "Save As" dialog to default sensibly.
   */
  async saveInboundMedia(input: {
    buffer: Buffer;
    mimeType: string;
    channelId: string;
    originalFilename?: string | null;
  }): Promise<UploadResult> {
    if (!input?.buffer?.byteLength) {
      throw new BadRequestException('Empty inbound media');
    }
    if (input.buffer.byteLength > UploadsService.MAX_INBOUND_BYTES) {
      throw new BadRequestException(
        `Inbound media too large (max ${UploadsService.MAX_INBOUND_BYTES / 1024 / 1024}MB)`,
      );
    }

    const mime = (input.mimeType || 'application/octet-stream').split(';')[0].trim();
    const dateFolder = new Date().toISOString().slice(0, 10);
    const safeChannel = (input.channelId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
    const dir = path.join(this.rootDir, 'inbound', safeChannel, dateFolder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const id = crypto.randomBytes(16).toString('hex');
    const ext = this.extFor(mime, input.originalFilename);
    const filename = `${id}${ext}`;
    const fullPath = path.join(dir, filename);
    await this.writeSafe(fullPath, input.buffer);

    const url = `${this.publicBaseUrl}/inbound/${safeChannel}/${dateFolder}/${filename}`;
    this.logger.log(`Inbound media saved: ${fullPath} -> ${url}`);
    return {
      url,
      mimeType: mime,
      size: input.buffer.byteLength,
      filename: input.originalFilename || filename,
    };
  }

  /**
   * Comprime imagem do operador NA ENTRADA (o grosso do disco é media/, quase
   * tudo imagem enviada pela operação). Reencoda com ffmpeg (já é dependência),
   * cap de 2000px, format-preserving (JPEG->JPEG, PNG->PNG, WebP->WebP) pra não
   * quebrar o envio nos providers. Se não reduzir ou falhar, devolve o original
   * — compressão NUNCA bloqueia o upload.
   */
  private async compressImage(buffer: Buffer, mime: string): Promise<Buffer> {
    const COMPRESSIBLE = new Set([
      'image/jpeg',
      'image/jpg',
      'image/png',
      'image/webp',
    ]);
    const MAX_DIM = 2000;
    const MIN_BYTES = 150 * 1024; // abaixo disso não compensa
    if (!COMPRESSIBLE.has(mime) || buffer.byteLength < MIN_BYTES) return buffer;
    const id = crypto.randomBytes(8).toString('hex');
    const ext = this.extFor(mime);
    const inPath = path.join(os.tmpdir(), `cmp_${id}_in${ext}`);
    const outPath = path.join(os.tmpdir(), `cmp_${id}_out${ext}`);
    try {
      await fs.promises.writeFile(inPath, buffer);
      const args = [
        '-hide_banner',
        '-loglevel',
        'error',
        '-y',
        '-i',
        inPath,
        '-vf',
        `scale='min(${MAX_DIM},iw)':'min(${MAX_DIM},ih)':force_original_aspect_ratio=decrease`,
      ];
      if (mime === 'image/webp') args.push('-quality', '80');
      else if (mime !== 'image/png') args.push('-q:v', '4'); // JPEG ~q82
      args.push(outPath);
      await execFileAsync('ffmpeg', args, { timeout: 30_000 });
      const out = await fs.promises.readFile(outPath);
      if (out.byteLength > 0 && out.byteLength < buffer.byteLength) {
        this.logger.log(
          `Imagem comprimida: ${(buffer.byteLength / 1024).toFixed(0)}KB -> ${(out.byteLength / 1024).toFixed(0)}KB (${mime})`,
        );
        return out;
      }
      return buffer;
    } catch (err: any) {
      this.logger.warn(
        `Compressão de imagem falhou (${mime}): ${err?.message ?? err}`,
      );
      return buffer;
    } finally {
      fs.promises.unlink(inPath).catch(() => undefined);
      fs.promises.unlink(outPath).catch(() => undefined);
    }
  }

  /**
   * Upload de mídia do operador (anexo do chat): imagem, vídeo ou documento.
   * Áudio gravado no app continua indo pelo saveAudio (que transcoda pra
   * OGG/Opus voice note); aqui é o caminho do clipe de papel.
   */
  async saveMedia(file: {
    buffer: Buffer;
    mimetype: string;
    originalname?: string;
  }): Promise<UploadResult> {
    if (!file?.buffer?.byteLength) {
      throw new BadRequestException('Empty upload');
    }
    if (file.buffer.byteLength > UploadsService.MAX_MEDIA_BYTES) {
      throw new BadRequestException(
        `File too large (max ${UploadsService.MAX_MEDIA_BYTES / 1024 / 1024}MB)`,
      );
    }
    const mime = (file.mimetype || 'application/octet-stream')
      .split(';')[0]
      .trim();
    if (!UploadsService.ALLOWED_MEDIA_MIME.has(mime)) {
      throw new BadRequestException(`Unsupported file type: ${mime}`);
    }

    // Compressão na entrada (imagem = 79% do disco). Se não reduzir, mantém o
    // original; falha na compressão nunca bloqueia o upload.
    const buffer = await this.compressImage(file.buffer, mime);

    const dateFolder = new Date().toISOString().slice(0, 10);
    const dir = path.join(this.rootDir, 'media', dateFolder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const id = crypto.randomBytes(16).toString('hex');
    const ext = this.extFor(mime, file.originalname);
    const filename = `${id}${ext}`;
    const fullPath = path.join(dir, filename);
    await this.writeSafe(fullPath, buffer);

    const url = `${this.publicBaseUrl}/media/${dateFolder}/${filename}`;
    this.logger.log(`Media saved: ${fullPath} -> ${url}`);
    return {
      url,
      mimeType: mime,
      size: buffer.byteLength,
      filename: file.originalname || filename,
    };
  }

  async saveAudio(file: {
    buffer: Buffer;
    mimetype: string;
    originalname?: string;
  }): Promise<UploadResult> {
    if (!file?.buffer?.byteLength) {
      throw new BadRequestException('Empty upload');
    }
    if (file.buffer.byteLength > UploadsService.MAX_AUDIO_BYTES) {
      throw new BadRequestException(
        `Audio too large (max ${UploadsService.MAX_AUDIO_BYTES / 1024 / 1024}MB)`,
      );
    }
    // Normalise mimetype: browsers sometimes send `audio/webm;codecs=opus`.
    const mime = (file.mimetype || '').split(';')[0].trim() || 'audio/webm';
    if (!UploadsService.ALLOWED_AUDIO_MIME.has(file.mimetype) && !UploadsService.ALLOWED_AUDIO_MIME.has(mime)) {
      throw new BadRequestException(`Unsupported audio mime type: ${file.mimetype}`);
    }

    const dateFolder = new Date().toISOString().slice(0, 10);
    const dir = path.join(this.rootDir, 'audio', dateFolder);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const id = crypto.randomBytes(16).toString('hex');
    const srcExt = this.extFor(mime);
    const srcPath = path.join(dir, `${id}${srcExt}`);
    await this.writeSafe(srcPath, file.buffer);

    // WhatsApp voice notes require OGG/Opus. Browsers (esp. Chrome/Firefox)
    // record in WebM/Opus via MediaRecorder — the codec is compatible but
    // the container is not, so Zappfy rejects the send (HTTP 500). We also
    // rely on the re-encode to write proper duration headers (MediaRecorder
    // streams webm without duration, so the <audio> element shows 0:00).
    let finalPath = srcPath;
    let finalMime = mime;
    if (mime !== 'audio/ogg') {
      const oggPath = path.join(dir, `${id}.ogg`);
      try {
        await execFileAsync(
          'ffmpeg',
          [
            '-hide_banner',
            '-loglevel', 'error',
            '-y',
            '-i', srcPath,
            '-vn',
            '-c:a', 'libopus',
            '-b:a', '32k',
            '-ac', '1',
            '-ar', '48000',
            '-application', 'voip',
            oggPath,
          ],
          { timeout: 30_000 },
        );
        await fs.promises.unlink(srcPath).catch(() => undefined);
        finalPath = oggPath;
        finalMime = 'audio/ogg';
      } catch (err: any) {
        this.logger.error(`ffmpeg transcode failed: ${err.message}`);
        throw new BadRequestException('Failed to process audio');
      }
    }

    const finalSize = (await fs.promises.stat(finalPath)).size;
    const finalName = path.basename(finalPath);
    const url = `${this.publicBaseUrl}/audio/${dateFolder}/${finalName}`;
    this.logger.log(`Audio saved: ${finalPath} -> ${url}`);
    return { url, mimeType: finalMime, size: finalSize, filename: finalName };
  }

  /**
   * Grava com resiliência a disco cheio: no primeiro ENOSPC, eviccta as mídias
   * MAIS ANTIGAS até liberar espaço e tenta de novo (o disco de uploads é um
   * cache limitado — perder o mais antigo é aceitável e mantém o chat vivo).
   * Se ainda faltar espaço, devolve 503 claro em vez de 500 cru.
   */
  private async writeSafe(fullPath: string, buffer: Buffer): Promise<void> {
    try {
      await fs.promises.writeFile(fullPath, buffer);
      return;
    } catch (err: any) {
      if (err?.code !== 'ENOSPC') throw err;
      this.logger.warn(
        `Disco de uploads cheio ao gravar ${fullPath} — evictando mídia antiga.`,
      );
      const freed = await this.emergencyEvict(
        buffer.byteLength * 3 + 16 * 1024 * 1024,
      ).catch(() => 0);
      this.logger.warn(
        `Evicção liberou ${(freed / 1024 / 1024).toFixed(1)}MB; tentando gravar de novo.`,
      );
      try {
        await fs.promises.writeFile(fullPath, buffer);
      } catch (err2: any) {
        if (err2?.code === 'ENOSPC') {
          this.logger.error('Disco de uploads segue cheio após evicção.');
          throw new ServiceUnavailableException(
            'Armazenamento de mídia cheio no momento. Tente novamente em instantes.',
          );
        }
        throw err2;
      }
    }
  }

  /** Lista todos os arquivos sob rootDir com tamanho e mtime (recursivo). */
  private async walkFiles(
    dir: string = this.rootDir,
  ): Promise<Array<{ path: string; size: number; mtimeMs: number }>> {
    const out: Array<{ path: string; size: number; mtimeMs: number }> = [];
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        out.push(...(await this.walkFiles(full)));
      } else if (e.isFile()) {
        try {
          const st = await fs.promises.stat(full);
          out.push({ path: full, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          /* arquivo sumiu no meio do caminho — ignora */
        }
      }
    }
    return out;
  }

  /** Apaga os arquivos mais antigos até liberar ~neededBytes. Retorna bytes liberados. */
  private async emergencyEvict(neededBytes: number): Promise<number> {
    const files = (await this.walkFiles()).sort((a, b) => a.mtimeMs - b.mtimeMs);
    let freed = 0;
    for (const f of files) {
      if (freed >= neededBytes) break;
      try {
        await fs.promises.unlink(f.path);
        freed += f.size;
      } catch {
        /* ignora falha pontual */
      }
    }
    return freed;
  }

  /**
   * Poda mídia além de `days` dias (retenção). Chamada no boot e a cada 12h
   * pelo UploadsRetentionService — mantém o disco de 1GB dentro do limite.
   */
  async pruneOlderThan(
    days: number = this.retentionDays,
  ): Promise<{ removed: number; freedBytes: number }> {
    if (!days || days <= 0) return { removed: 0, freedBytes: 0 };
    const cutoff = Date.now() - days * 86_400_000;
    const files = await this.walkFiles();
    let removed = 0;
    let freedBytes = 0;
    for (const f of files) {
      if (f.mtimeMs >= cutoff) continue;
      try {
        await fs.promises.unlink(f.path);
        removed += 1;
        freedBytes += f.size;
      } catch {
        /* ignora */
      }
    }
    if (removed > 0) {
      this.logger.log(
        `Retenção: ${removed} arquivos > ${days}d removidos, ${(freedBytes / 1024 / 1024).toFixed(1)}MB liberados.`,
      );
    }
    return { removed, freedBytes };
  }

  /**
   * Diagnóstico de uso do disco de uploads: total, quebra por categoria
   * (inbound/media/audio) e por canal (dentro de inbound), maiores arquivos e
   * quanto a retenção atual liberaria. Só leitura — não apaga nada.
   */
  async getDiskStats(topN = 15): Promise<{
    rootDir: string;
    retentionDays: number;
    totalFiles: number;
    totalMB: number;
    oldest: string | null;
    newest: string | null;
    freeableByRetentionMB: number;
    freeableByRetentionFiles: number;
    byCategory: Array<{ category: string; files: number; mb: number }>;
    byChannel: Array<{ channel: string; files: number; mb: number }>;
    largest: Array<{ path: string; mb: number; mtime: string }>;
  }> {
    const files = await this.walkFiles();
    const mb = (b: number) => Math.round((b / 1024 / 1024) * 100) / 100;
    let totalBytes = 0;
    let oldest = Number.POSITIVE_INFINITY;
    let newest = 0;
    const cutoff = Date.now() - (this.retentionDays || 45) * 86_400_000;
    let freeableBytes = 0;
    let freeableFiles = 0;
    const cat = new Map<string, { files: number; bytes: number }>();
    const chan = new Map<string, { files: number; bytes: number }>();
    for (const f of files) {
      totalBytes += f.size;
      if (f.mtimeMs < oldest) oldest = f.mtimeMs;
      if (f.mtimeMs > newest) newest = f.mtimeMs;
      if (this.retentionDays > 0 && f.mtimeMs < cutoff) {
        freeableBytes += f.size;
        freeableFiles += 1;
      }
      const rel = path.relative(this.rootDir, f.path);
      const seg = rel.split(path.sep);
      const category = seg[0] || 'root';
      const c = cat.get(category) ?? { files: 0, bytes: 0 };
      c.files += 1;
      c.bytes += f.size;
      cat.set(category, c);
      if (category === 'inbound' && seg[1]) {
        const ch = chan.get(seg[1]) ?? { files: 0, bytes: 0 };
        ch.files += 1;
        ch.bytes += f.size;
        chan.set(seg[1], ch);
      }
    }
    const largest = [...files]
      .sort((a, b) => b.size - a.size)
      .slice(0, topN)
      .map((f) => ({
        path: path.relative(this.rootDir, f.path),
        mb: mb(f.size),
        mtime: new Date(f.mtimeMs).toISOString(),
      }));
    return {
      rootDir: this.rootDir,
      retentionDays: this.retentionDays,
      totalFiles: files.length,
      totalMB: mb(totalBytes),
      oldest: files.length ? new Date(oldest).toISOString() : null,
      newest: files.length ? new Date(newest).toISOString() : null,
      freeableByRetentionMB: mb(freeableBytes),
      freeableByRetentionFiles: freeableFiles,
      byCategory: [...cat.entries()]
        .map(([category, v]) => ({ category, files: v.files, mb: mb(v.bytes) }))
        .sort((a, b) => b.mb - a.mb),
      byChannel: [...chan.entries()]
        .map(([channel, v]) => ({ channel, files: v.files, mb: mb(v.bytes) }))
        .sort((a, b) => b.mb - a.mb),
      largest,
    };
  }

  private extFor(mime: string, originalFilename?: string | null): string {
    // Prefer the extension from the provider-given filename when present —
    // it survives mime-sniffing oddities (e.g., Meta sometimes returns
    // application/octet-stream for known doc types).
    if (originalFilename) {
      const ext = path.extname(originalFilename).toLowerCase();
      if (ext && /^\.[a-z0-9]{1,8}$/i.test(ext)) return ext;
    }
    const m = (mime || '').toLowerCase();
    // audio
    if (m.includes('ogg')) return '.ogg';
    if (m.includes('mpeg') && m.startsWith('audio/')) return '.mp3';
    if (m.includes('m4a') || (m.includes('mp4') && m.startsWith('audio/'))) return '.m4a';
    if (m.includes('wav')) return '.wav';
    if (m.includes('webm') && m.startsWith('audio/')) return '.webm';
    // image
    if (m === 'image/jpeg' || m === 'image/jpg') return '.jpg';
    if (m === 'image/png') return '.png';
    if (m === 'image/gif') return '.gif';
    if (m === 'image/webp') return '.webp';
    if (m === 'image/heic') return '.heic';
    // video
    if (m === 'video/mp4') return '.mp4';
    if (m === 'video/quicktime') return '.mov';
    if (m === 'video/3gpp') return '.3gp';
    if (m === 'video/webm') return '.webm';
    // document
    if (m === 'application/pdf') return '.pdf';
    if (m === 'application/zip') return '.zip';
    if (m === 'application/msword') return '.doc';
    if (m === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') return '.docx';
    if (m === 'application/vnd.ms-excel') return '.xls';
    if (m === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') return '.xlsx';
    if (m === 'application/vnd.ms-powerpoint') return '.ppt';
    if (m === 'application/vnd.openxmlformats-officedocument.presentationml.presentation') return '.pptx';
    if (m === 'text/plain') return '.txt';
    if (m === 'text/csv') return '.csv';
    return '.bin';
  }
}
