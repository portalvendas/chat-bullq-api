import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';

import { PrismaService } from '../../../database/prisma.service';
import {
  decryptString,
  encryptString,
  isEncryptionEnabled,
} from '../../../common/crypto/secret-cipher';
import { LlmService } from './llm.service';

export interface AiKeyStatus {
  /** true = empresa tem chave própria configurada. */
  configured: boolean;
  /** Mascarado (ex.: "sk-ant-…a1b2"). null quando não configurada. */
  hint: string | null;
  /** true quando ENCRYPTION_KEY está setada (chave cifrada em repouso). */
  encryptedAtRest: boolean;
}

/**
 * Gestão da chave da API do Claude (Anthropic) POR EMPRESA (BYOK).
 *
 * - Nunca devolve a chave em claro — só um mascarado.
 * - Cifra em repouso via secret-cipher (AES-256-GCM, env ENCRYPTION_KEY).
 * - Valida a chave com uma chamada real mínima à Anthropic antes de gravar.
 * - Invalida o cache do LlmService ao salvar/remover (efeito imediato).
 */
@Injectable()
export class LlmKeyService {
  private readonly logger = new Logger(LlmKeyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
  ) {}

  async getStatus(organizationId: string): Promise<AiKeyStatus> {
    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      select: { aiAnthropicKeyEnc: true },
    });
    const enc = org?.aiAnthropicKeyEnc ?? null;
    return {
      configured: !!enc,
      hint: enc ? this.mask(safeDecrypt(enc)) : null,
      encryptedAtRest: isEncryptionEnabled(),
    };
  }

  /**
   * Salva (ou substitui) a chave da empresa. Por padrão VALIDA a chave com a
   * Anthropic antes de gravar; `test=false` pula a validação (não recomendado).
   */
  async setKey(
    organizationId: string,
    rawKey: string,
    opts: { test?: boolean } = {},
  ): Promise<AiKeyStatus> {
    const key = (rawKey ?? '').trim();
    if (!key) throw new BadRequestException('Chave vazia.');
    if (!key.startsWith('sk-ant-')) {
      throw new BadRequestException(
        'Formato inválido: a chave da Anthropic começa com "sk-ant-".',
      );
    }
    if (opts.test !== false) {
      await this.validateWithAnthropic(key);
    }
    if (!isEncryptionEnabled()) {
      this.logger.warn(
        `ENCRYPTION_KEY ausente — chave da org ${organizationId} será gravada em TEXTO PURO. Configure ENCRYPTION_KEY.`,
      );
    }
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { aiAnthropicKeyEnc: encryptString(key) },
    });
    this.llm.invalidateOrg(organizationId);
    this.logger.log(`Chave do Claude configurada para org ${organizationId}`);
    return this.getStatus(organizationId);
  }

  async clearKey(organizationId: string): Promise<AiKeyStatus> {
    await this.prisma.organization.update({
      where: { id: organizationId },
      data: { aiAnthropicKeyEnc: null },
    });
    this.llm.invalidateOrg(organizationId);
    this.logger.log(`Chave do Claude removida da org ${organizationId}`);
    return this.getStatus(organizationId);
  }

  /** Faz uma chamada mínima pra confirmar que a chave autentica. */
  private async validateWithAnthropic(apiKey: string): Promise<void> {
    const client = new Anthropic({ apiKey });
    try {
      await client.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 1,
        messages: [{ role: 'user', content: 'ping' }],
      });
    } catch (err) {
      if (
        err instanceof Anthropic.AuthenticationError ||
        err instanceof Anthropic.PermissionDeniedError
      ) {
        throw new BadRequestException(
          'Chave rejeitada pela Anthropic (inválida ou sem permissão).',
        );
      }
      // Erro não relacionado a auth (rede/limite): não gravamos às cegas.
      this.logger.error(
        `Falha ao validar chave na Anthropic: ${(err as Error)?.message}`,
      );
      throw new ServiceUnavailableException(
        'Não foi possível validar a chave agora. Tente novamente em instantes.',
      );
    }
  }

  private mask(key: string): string {
    if (!key || key.length < 8) return '••••';
    return `sk-ant-…${key.slice(-4)}`;
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
