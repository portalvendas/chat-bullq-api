import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { PrismaService } from '../../../database/prisma.service';
import {
  decryptString,
  encryptString,
  isEncryptionEnabled,
} from '../../../common/crypto/secret-cipher';

export interface OpenAiKeyStatus {
  /** true = empresa tem chave própria configurada. */
  configured: boolean;
  /** Mascarado (ex.: "sk-…a1b2"). null quando não configurada. */
  hint: string | null;
  /** true quando ENCRYPTION_KEY está setada (chave cifrada em repouso). */
  encryptedAtRest: boolean;
}

/**
 * Gestão da chave da API da OpenAI POR EMPRESA (BYOK) — usada na transcrição de
 * áudio (Whisper). Espelha o LlmKeyService (Anthropic):
 * - Nunca devolve a chave em claro — só um mascarado.
 * - Cifra em repouso via secret-cipher (AES-256-GCM, env ENCRYPTION_KEY).
 * - Valida a chave com uma chamada mínima (/v1/models) antes de gravar.
 * - `resolveKey` devolve a chave crua: a da empresa (decifrada) ou, no
 *   fallback, a global do servidor (env OPENAI_API_KEY).
 */
@Injectable()
export class OpenaiKeyService {
  private readonly logger = new Logger(OpenaiKeyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async getStatus(organizationId: string): Promise<OpenAiKeyStatus> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { aiOpenaiKeyEnc: true },
    });
    const enc = org?.aiOpenaiKeyEnc ?? null;
    return {
      configured: !!enc,
      hint: enc ? this.mask(safeDecrypt(enc)) : null,
      encryptedAtRest: isEncryptionEnabled(),
    };
  }

  async setKey(
    organizationId: string,
    rawKey: string,
    opts: { test?: boolean } = {},
  ): Promise<OpenAiKeyStatus> {
    const key = (rawKey ?? '').trim();
    if (!key) throw new BadRequestException('Chave vazia.');
    if (!key.startsWith('sk-')) {
      throw new BadRequestException(
        'Formato inválido: a chave da OpenAI começa com "sk-".',
      );
    }
    if (opts.test !== false) {
      await this.validateWithOpenAI(key);
    }
    if (!isEncryptionEnabled()) {
      this.logger.warn(
        `ENCRYPTION_KEY ausente — chave OpenAI da org ${organizationId} será gravada em TEXTO PURO. Configure ENCRYPTION_KEY.`,
      );
    }
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { aiOpenaiKeyEnc: encryptString(key) },
    });
    this.logger.log(`Chave da OpenAI configurada para org ${organizationId}`);
    return this.getStatus(organizationId);
  }

  async clearKey(organizationId: string): Promise<OpenAiKeyStatus> {
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { aiOpenaiKeyEnc: null },
    });
    this.logger.log(`Chave da OpenAI removida da org ${organizationId}`);
    return this.getStatus(organizationId);
  }

  /**
   * Chave crua da OpenAI pra usar numa chamada: a da empresa (decifrada) →
   * fallback na global do servidor (env OPENAI_API_KEY). null se nenhuma.
   */
  async resolveKey(organizationId?: string | null): Promise<string | null> {
    if (organizationId) {
      const org = await this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { aiOpenaiKeyEnc: true },
      });
      if (org?.aiOpenaiKeyEnc) {
        const k = safeDecrypt(org.aiOpenaiKeyEnc);
        if (k) return k;
      }
    }
    return this.config.get<string>('OPENAI_API_KEY') ?? null;
  }

  /** Chamada mínima pra confirmar que a chave autentica. */
  private async validateWithOpenAI(apiKey: string): Promise<void> {
    try {
      await axios.get('https://api.openai.com/v1/models', {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeout: 15000,
      });
    } catch (err: any) {
      const status = err?.response?.status;
      if (status === 401 || status === 403) {
        throw new BadRequestException(
          'Chave rejeitada pela OpenAI (inválida ou sem permissão).',
        );
      }
      this.logger.error(
        `Falha ao validar chave na OpenAI: ${err?.message ?? err}`,
      );
      throw new ServiceUnavailableException(
        'Não foi possível validar a chave agora. Tente novamente em instantes.',
      );
    }
  }

  private mask(key: string): string {
    if (!key || key.length < 8) return '••••';
    return `sk-…${key.slice(-4)}`;
  }
}

/** Decifra tolerante (valor legado sem envelope passa direto). */
function safeDecrypt(enc: string): string {
  try {
    return decryptString(enc);
  } catch {
    return '';
  }
}
