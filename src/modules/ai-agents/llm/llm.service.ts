import {
  Injectable,
  Logger,
  InternalServerErrorException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Anthropic from '@anthropic-ai/sdk';

import { PrismaService } from '../../../database/prisma.service';
import { decryptString } from '../../../common/crypto/secret-cipher';
import { LlmContext } from './llm-context';

import {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmMessage,
  LlmToolCall,
  LlmToolDefinition,
  LlmUsage,
} from './llm.types';

/**
 * Cliente da Anthropic API (Claude).
 *
 * - Mantém a interface pública (`complete()`, `LlmMessage`, etc).
 * - Aceita modelId já no formato Anthropic (`claude-sonnet-4-6`) ou com
 *   prefix `anthropic/` por retrocompat — o prefix é despido antes da
 *   chamada.
 * - Prompt caching ephemeral nativo: `system` em blocks com cache_control,
 *   tools com cache no último elemento.
 * - Custo calculado client-side (Anthropic não retorna `cost` no response).
 */
type OrgClientCache = {
  client: Anthropic;
  /** Valor cifrado atual (fingerprint) — rebuild do client se mudar. */
  fingerprint: string;
  fetchedAt: number;
};

/** TTL do cache de client por org — evita read no banco a cada chamada. */
const ORG_CLIENT_TTL_MS = 30_000;

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly globalClient: Anthropic;
  private readonly globalApiKey?: string;
  /**
   * Se true (default), orgs SEM chave própria usam a chave global da
   * plataforma. LLM_ALLOW_PLATFORM_FALLBACK=false força BYOK estrito: org sem
   * chave própria é bloqueada (503) em vez de cair na chave global.
   */
  private readonly allowPlatformFallback: boolean;
  /** Cache de client Anthropic por org (evita rebuild + read a cada chamada). */
  private readonly orgClients = new Map<string, OrgClientCache>();

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {
    this.globalApiKey =
      this.config.get<string>('ANTHROPIC_API_KEY') || undefined;
    this.allowPlatformFallback =
      (this.config.get<string>('LLM_ALLOW_PLATFORM_FALLBACK') ?? 'true')
        .toLowerCase() !== 'false';
    if (!this.globalApiKey) {
      this.logger.warn(
        'ANTHROPIC_API_KEY (global) não setada — orgs sem chave própria falharão',
      );
    }
    this.globalClient = new Anthropic({
      apiKey: this.globalApiKey ?? 'missing',
    });
  }

  /** Invalida o client cacheado de uma org (chamar após salvar/remover chave). */
  invalidateOrg(organizationId: string): void {
    this.orgClients.delete(organizationId);
  }

  /**
   * Resolve o client Anthropic da chamada:
   *  - org (explícita em req.organizationId ou via LlmContext) COM chave
   *    própria → client da org (cache 30s, rebuild se a chave mudar);
   *  - org SEM chave → fallback global se permitido, senão bloqueia (503);
   *  - sem org (evals/interno) → client global.
   */
  private async resolveClient(explicitOrgId?: string): Promise<Anthropic> {
    const orgId = explicitOrgId ?? LlmContext.organizationId();
    if (!orgId) return this.requireGlobal();

    const cached = this.orgClients.get(orgId);
    if (cached && Date.now() - cached.fetchedAt < ORG_CLIENT_TTL_MS) {
      return cached.client;
    }

    let enc: string | null = null;
    let readFailed = false;
    try {
      const org = await this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { aiAnthropicKeyEnc: true },
      });
      enc = org?.aiAnthropicKeyEnc ?? null;
    } catch (err) {
      readFailed = true;
      this.logger.error(
        `Falha ao ler chave da org ${orgId}: ${(err as Error)?.message}`,
      );
    }

    // Glitch transitório no banco: se já temos um client em cache, reusa
    // (stale) em vez de bloquear/derrubar uma org que TEM chave.
    if (readFailed && cached) return cached.client;

    if (enc) {
      // Reaproveita o client se a chave (fingerprint) não mudou.
      if (cached && cached.fingerprint === enc) {
        cached.fetchedAt = Date.now();
        return cached.client;
      }
      const apiKey = decryptString(enc);
      const client = new Anthropic({ apiKey });
      this.orgClients.set(orgId, {
        client,
        fingerprint: enc,
        fetchedAt: Date.now(),
      });
      return client;
    }

    // Org sem chave própria.
    if (this.allowPlatformFallback && this.globalApiKey) {
      return this.globalClient;
    }
    throw new ServiceUnavailableException(
      'IA não configurada para esta empresa: defina a chave da API do Claude em Configurações → IA.',
    );
  }

  private requireGlobal(): Anthropic {
    if (!this.globalApiKey) {
      throw new ServiceUnavailableException(
        'IA indisponível: chave da Anthropic não configurada.',
      );
    }
    return this.globalClient;
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const modelId = this.normalizeModelId(req.modelId);
    const { system, messages } = this.toAnthropicMessages(req.messages);
    const tools = req.tools
      ? this.toAnthropicTools(this.sanitizeTools(req.tools))
      : undefined;

    // Opus 4.7 removeu sampling parameters — passa temperature/top_p/top_k
    // e a API retorna 400. Omitir quando o modelo for Opus 4.7+.
    const supportsTemperature = !this.isOpus47(modelId);

    const client = await this.resolveClient(req.organizationId);

    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: modelId,
        max_tokens: req.maxTokens ?? 2048,
        ...(supportsTemperature
          ? { temperature: req.temperature ?? 0.7 }
          : {}),
        ...(system ? { system } : {}),
        messages,
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(this.sanitizeModelParams(req.modelParams, modelId) as object),
      });
    } catch (err: unknown) {
      this.handleAnthropicError(err, modelId, tools, messages, system);
      throw new InternalServerErrorException(
        `LLM provider error: ${this.errorMessage(err)}`,
      );
    }

    const message = this.fromAnthropicMessage(response);
    const stopReason = this.normalizeStopReason(response.stop_reason);
    const usage = this.extractUsage(response.usage, modelId);

    return {
      message,
      stopReason,
      usage,
      rawModelId: response.model ?? modelId,
    };
  }

  // ─── conversão: nossos tipos → Anthropic SDK ─────────────────────

  /**
   * Aceita IDs com prefix `anthropic/` por retrocompat (formato antigo) e
   * retorna o ID exato que a Anthropic API espera.
   */
  private normalizeModelId(id: string): string {
    if (id.startsWith('anthropic/')) return id.slice('anthropic/'.length);
    return id;
  }

  /**
   * Converte nosso array `LlmMessage[]` (formato OpenAI-like com role
   * 'system'/'tool' soltos) pro shape Anthropic:
   *   - `system`: blocks separados (não no array de messages).
   *   - `messages`: só user/assistant; tool results viram blocks
   *     `tool_result` dentro de uma user message; tool calls viram
   *     blocks `tool_use` dentro de uma assistant message.
   *   - mensagens 'tool' consecutivas são agrupadas numa única user
   *     message com múltiplos tool_result blocks (formato canônico).
   */
  private toAnthropicMessages(input: LlmMessage[]): {
    system?: Anthropic.TextBlockParam[];
    messages: Anthropic.MessageParam[];
  } {
    let system: Anthropic.TextBlockParam[] | undefined;
    const out: Anthropic.MessageParam[] = [];
    let pendingToolResults: Anthropic.ToolResultBlockParam[] = [];

    const flushToolResults = () => {
      if (pendingToolResults.length === 0) return;
      out.push({ role: 'user', content: pendingToolResults });
      pendingToolResults = [];
    };

    for (const m of input) {
      if (m.role === 'system') {
        // System só aceita texto na Anthropic — filtra qualquer image
        // que indevidamente apareça aqui (não deveria, system é construído
        // pelo prompt-builder com texto only).
        const blocks = this.toTextBlocks(m.content);
        if (blocks.length > 0) system = blocks;
        continue;
      }

      if (m.role === 'tool') {
        const text =
          typeof m.content === 'string'
            ? m.content
            : m.content
                .filter((b) => b.type === 'text')
                .map((b) => (b as { text: string }).text)
                .join('');
        if (!m.toolCallId) {
          this.logger.warn('Tool message without toolCallId — dropping');
          continue;
        }
        pendingToolResults.push({
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content: text || '(empty)',
        });
        continue;
      }

      flushToolResults();

      if (m.role === 'user') {
        // User pode ter texto + imagem (vision). Mantemos string simples
        // quando é texto puro sem cache, pra cair no fast-path antigo.
        const blocks = this.toUserContentBlocks(m.content);
        if (blocks.length === 0) continue;
        const hasNonText = blocks.some((b) => b.type !== 'text');
        const hasCache = blocks.some(
          (b) =>
            b.type === 'text' &&
            (b as Anthropic.TextBlockParam).cache_control !== undefined,
        );
        if (!hasNonText && !hasCache) {
          out.push({
            role: 'user',
            content: blocks.map((b) =>
              b.type === 'text' ? (b as Anthropic.TextBlockParam).text : '',
            ).join(''),
          });
        } else {
          out.push({ role: 'user', content: blocks });
        }
        continue;
      }

      if (m.role === 'assistant') {
        // Assistant não retorna imagens — filtramos qualquer image part
        // por defesa (não deveria aparecer aqui).
        const text =
          typeof m.content === 'string'
            ? m.content
            : m.content
                .filter((b) => b.type === 'text')
                .map((b) => (b as { text: string }).text)
                .join('');
        const contentBlocks: Array<
          Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam
        > = [];
        if (text && text.trim().length > 0) {
          contentBlocks.push({ type: 'text', text });
        }
        for (const tc of m.toolCalls ?? []) {
          contentBlocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        // Anthropic não aceita assistant message vazio. Pula em vez de 400.
        if (contentBlocks.length === 0) continue;
        out.push({ role: 'assistant', content: contentBlocks });
      }
    }

    flushToolResults();

    return { system, messages: out };
  }

  /**
   * Normaliza content em `TextBlockParam[]`. Para uso onde só TEXTO faz
   * sentido (system prompt). Filtra image parts e blocks vazios.
   */
  private toTextBlocks(
    content: LlmMessage['content'],
  ): Anthropic.TextBlockParam[] {
    const raw =
      typeof content === 'string'
        ? [{ type: 'text' as const, text: content }]
        : content;
    const blocks: Anthropic.TextBlockParam[] = [];
    for (const part of raw) {
      if (part.type !== 'text') continue;
      if (!part.text || part.text.length === 0) continue;
      const block: Anthropic.TextBlockParam = { type: 'text', text: part.text };
      if ('cache' in part && part.cache) {
        // TTL 1h no prefixo estável do system: mantém quente entre turns
        // espaçados da mesma conversa (atendimento tem gaps > 5min). Vem
        // depois das tools (também 1h) no prefixo — ordem 1h→1h é válida.
        block.cache_control = { type: 'ephemeral', ttl: '1h' };
      }
      blocks.push(block);
    }
    return blocks;
  }

  /**
   * Normaliza content de mensagem `user` em blocks que a Anthropic aceita
   * em messages: text + image. Image vai como `source.type='url'` quando
   * temos URL pública (caso default — todos os 3 canais resolvem mídia
   * pra URL nossa via media-resolver) ou `source.type='base64'` quando
   * passaram base64 explícito.
   */
  private toUserContentBlocks(
    content: LlmMessage['content'],
  ): Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> {
    const raw =
      typeof content === 'string'
        ? [{ type: 'text' as const, text: content }]
        : content;
    const blocks: Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> =
      [];
    for (const part of raw) {
      if (part.type === 'text') {
        if (!part.text || part.text.length === 0) continue;
        const block: Anthropic.TextBlockParam = {
          type: 'text',
          text: part.text,
        };
        if ('cache' in part && part.cache) {
          block.cache_control = { type: 'ephemeral' };
        }
        blocks.push(block);
        continue;
      }
      if (part.type === 'image') {
        if (part.url) {
          blocks.push({
            type: 'image',
            source: { type: 'url', url: part.url },
          });
        } else if (part.base64) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.base64
                .mediaType as Anthropic.Base64ImageSource['media_type'],
              data: part.base64.data,
            },
          });
        }
        // Image sem url nem base64 → drop silenciosamente.
      }
    }
    return blocks;
  }

  /**
   * Filtra tools com schema obviamente quebrado antes de mandar pra API.
   * Um schema malformado (faltando `type:object`, properties não-objeto,
   * etc) faz a API inteira 400 — perdemos UMA tool é melhor que perder
   * o turno todo.
   */
  private sanitizeTools(tools: LlmToolDefinition[]): LlmToolDefinition[] {
    const valid: LlmToolDefinition[] = [];
    for (const t of tools) {
      const reason = this.validateToolSchema(t);
      if (reason) {
        this.logger.warn(
          `Dropping tool ${t.name} from LLM request: ${reason}`,
        );
        continue;
      }
      valid.push(t);
    }
    return valid;
  }

  private validateToolSchema(t: LlmToolDefinition): string | null {
    if (!t.name || typeof t.name !== 'string') return 'missing name';
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name))
      return `invalid name "${t.name}" — must match [a-zA-Z0-9_-]{1,64}`;
    if (!t.description || typeof t.description !== 'string')
      return 'missing description';
    const p = t.parameters as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object') return 'parameters not an object';
    if (p.type !== 'object')
      return `parameters.type must be "object", got ${JSON.stringify(p.type)}`;
    if (p.properties && typeof p.properties !== 'object')
      return 'parameters.properties must be an object';
    return null;
  }

  /**
   * Converte tools pro shape Anthropic e marca o ÚLTIMO tool como
   * cacheable. Anthropic interpreta `cache_control` em qualquer
   * tool como "cache toda a array de tools até aqui" — então marcar
   * o último basta pra cachear todas (95%+ economia em tools que
   * não mudam entre turns).
   *
   * TTL de 1h (não os 5min padrão): as tools são IDÊNTICAS entre todas as
   * conversas e runs (vêm antes do system no prefixo), então o cache delas é
   * reaproveitado globalmente. Com 1h o bloco fica quente ao longo da hora
   * inteira de tráfego → quase todo call LÊ as tools (0.1x) em vez de
   * REESCREVER (1.25x). A escrita 1h custa 2x uma vez, mas é amortizada por
   * dezenas de leituras. Ordem do prefixo (tools→system): TTL maior (1h) vem
   * antes do menor (system 5min), como a API exige.
   */
  private toAnthropicTools(tools: LlmToolDefinition[]): Anthropic.ToolUnion[] {
    const result: Anthropic.Tool[] = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters as Anthropic.Tool.InputSchema,
    }));
    if (result.length > 0) {
      result[result.length - 1].cache_control = { type: 'ephemeral', ttl: '1h' };
    }
    return result;
  }

  /**
   * Opus 4.7+ removeu sampling parameters (temperature, top_p, top_k) —
   * mandar qualquer um retorna 400 `<param> is deprecated for this model`.
   * Outros modelos (Sonnet, Haiku) continuam aceitando normalmente.
   */
  private isOpus47(modelId: string): boolean {
    return /^claude-opus-4-(7|8|9|\d{2,})/.test(modelId);
  }

  /**
   * Passa adiante apenas os params que a Anthropic API aceita —
   * evita 400 por campo desconhecido em call sites genéricos. Em Opus 4.7
   * também filtra os sampling parameters (que foram removidos do modelo).
   */
  private sanitizeModelParams(
    params: Record<string, unknown> | undefined,
    modelId: string,
  ): Record<string, unknown> {
    if (!params) return {};
    const samplingBanned = this.isOpus47(modelId);
    const allowed = new Set([
      ...(samplingBanned ? [] : ['top_p', 'top_k']),
      'stop_sequences',
      'metadata',
      'service_tier',
      'thinking',
    ]);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (allowed.has(k)) out[k] = v;
    }
    return out;
  }

  // ─── conversão: Anthropic SDK → nossos tipos ─────────────────────

  private fromAnthropicMessage(response: Anthropic.Message): LlmMessage {
    let textContent = '';
    const toolCalls: LlmToolCall[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        textContent += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: (block.input ?? {}) as Record<string, unknown>,
        });
      }
      // 'thinking' / 'redacted_thinking' / 'server_tool_use' / etc — ignora
    }

    return {
      role: 'assistant',
      content: textContent,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  private normalizeStopReason(
    reason: Anthropic.Message['stop_reason'],
  ): LlmCompletionResponse['stopReason'] {
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
        return 'stop';
      case 'tool_use':
      case 'pause_turn':
        return 'tool_calls';
      case 'max_tokens':
        return 'length';
      case 'refusal':
        return 'content_filter';
      default:
        return 'other';
    }
  }

  private extractUsage(
    usage: Anthropic.Usage,
    modelId: string,
  ): LlmUsage {
    const input = usage.input_tokens ?? 0;
    const output = usage.output_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const cacheWrite = usage.cache_creation_input_tokens ?? 0;
    return {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd: this.calculateCost(modelId, {
        input,
        output,
        cacheRead,
        cacheWrite,
      }),
    };
  }

  /**
   * Calcula custo USD client-side — Anthropic não retorna `cost` no
   * response. Tabela de preços por modelo + cache read/write próprios.
   */
  private calculateCost(
    modelId: string,
    tokens: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    },
  ): number {
    const p =
      MODEL_PRICING_USD_PER_MTOK[modelId] ??
      MODEL_PRICING_USD_PER_MTOK.default;
    return (
      (tokens.input * p.input +
        tokens.output * p.output +
        tokens.cacheRead * p.cacheRead +
        tokens.cacheWrite * p.cacheWrite) /
      1_000_000
    );
  }

  // ─── error handling ──────────────────────────────────────────────

  private handleAnthropicError(
    err: unknown,
    modelId: string,
    tools: Anthropic.ToolUnion[] | undefined,
    messages: Anthropic.MessageParam[],
    system: Anthropic.TextBlockParam[] | undefined,
  ): void {
    const status =
      err instanceof Anthropic.APIError ? err.status : undefined;
    const message = this.errorMessage(err);
    const toolNames = tools?.map((t) => (t as Anthropic.Tool).name).join(',');
    this.logger.error(
      `LLM call failed [${modelId}] status=${status ?? '?'}: ${message} | tools=[${toolNames ?? ''}]`,
    );
    if (err instanceof Anthropic.BadRequestError) {
      // 400 — dump prompt sample + tools pra ajudar a debugar
      this.logger.debug(`Messages count: ${messages.length}`);
      if (system && system.length > 0) {
        const sample = system[0].text.slice(0, 600);
        this.logger.debug(`System sample: ${sample}...`);
      }
      if (tools) {
        this.logger.debug(
          `Tools dump: ${safeStringify(tools).slice(0, 4000)}`,
        );
      }
    }
  }

  private errorMessage(err: unknown): string {
    if (err instanceof Anthropic.APIError) {
      return `${err.name}(${err.status}): ${err.message}`;
    }
    if (err instanceof Error) return err.message;
    return String(err);
  }
}

/**
 * Tabela de preços (USD por 1M tokens) por modelo. Espelha a tabela
 * pública da Anthropic em platform.claude.com/docs/en/pricing.
 */
const MODEL_PRICING_USD_PER_MTOK: Record<
  string,
  { input: number; output: number; cacheRead: number; cacheWrite: number }
> = {
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-opus-4-7':   { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6':   { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-haiku-4-5':  { input: 1, output: 5,  cacheRead: 0.1, cacheWrite: 1.25 },
  // Fallback conservador (assume Sonnet) pra IDs desconhecidos.
  default: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
};

function safeStringify(input: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(input, (_key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
  } catch (err) {
    return `[unstringifyable: ${(err as Error)?.message}]`;
  }
}
