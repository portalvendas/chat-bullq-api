import {
  Injectable,
  Logger,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { UploadsService } from '../messaging/messages/uploads.service';
import { LlmService } from '../ai-agents/llm/llm.service';
import type { LlmContentPart, LlmToolDefinition } from '../ai-agents/llm/llm.types';

/** Formas de pagamento reconhecidas no comprovante. */
const METODOS = [
  'pix',
  'cartao',
  'parcelamento',
  'boleto',
  'transferencia',
  'dinheiro',
  'outro',
  'desconhecido',
] as const;

/** Modelo barato com visão pra ler o comprovante. */
const EXTRACTION_MODEL = 'claude-haiku-4-5';

/** Imagens aceitas pela visão da Anthropic (demais caem como falha → manual). */
const VISION_IMAGE_MIME: Record<string, string> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/png': 'image/png',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
};

interface ExtractResult {
  ehComprovante: boolean | null;
  valor: number | null;
  metodo: string | null;
  parcelas: number | null;
  data: Date | null;
  observacao: string | null;
  ok: boolean;
}

/**
 * Comprovantes de pagamento por pedido (TinyDocument). Faz upload do arquivo
 * (PDF/JPG), extrai forma de pagamento + valor + data por IA (visão da
 * Anthropic, com a chave da org) e permite editar/listar/remover. A soma dos
 * comprovantes é comparada com o total do pedido na listagem (tiny.service).
 */
@Injectable()
export class TinyReceiptsService {
  private readonly logger = new Logger(TinyReceiptsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly uploads: UploadsService,
    private readonly llm: LlmService,
  ) {}

  /** Garante que o pedido existe e é da org. Retorna {id, valor}. */
  private async assertDoc(organizationId: string, docId: string) {
    const doc = await this.prisma.tinyDocument.findFirst({
      where: { id: docId, organizationId },
      select: { id: true, valor: true },
    });
    if (!doc) throw new NotFoundException('Pedido não encontrado');
    return doc;
  }

  async list(organizationId: string, docId: string) {
    await this.assertDoc(organizationId, docId);
    const receipts = await this.prisma.tinyReceipt.findMany({
      where: { tinyDocumentId: docId, organizationId },
      orderBy: { createdAt: 'asc' },
    });
    return receipts.map((r) => this.serialize(r));
  }

  /**
   * Anexa um comprovante: salva o arquivo, cria a linha e dispara a extração
   * por IA na hora (await — o front mostra o resultado). Falha na extração não
   * derruba o upload: fica statusExtracao='falhou' pra preencher à mão.
   */
  async upload(
    organizationId: string,
    docId: string,
    file: { buffer: Buffer; mimetype: string; originalname?: string },
    userId?: string | null,
  ) {
    await this.assertDoc(organizationId, docId);
    if (!file?.buffer?.length) {
      throw new BadRequestException('Arquivo vazio');
    }

    const saved = await this.uploads.saveMedia({
      buffer: file.buffer,
      mimetype: file.mimetype,
      originalname: file.originalname,
    });

    const created = await this.prisma.tinyReceipt.create({
      data: {
        organizationId,
        tinyDocumentId: docId,
        url: saved.url,
        mimeType: saved.mimeType,
        fileName: file.originalname ?? null,
        uploadedById: userId ?? null,
        statusExtracao: 'pendente',
      },
    });

    // Extração best-effort.
    let result: ExtractResult | null = null;
    try {
      result = await this.extract(organizationId, file.buffer, file.mimetype);
    } catch (err: any) {
      this.logger.warn(
        `Extração do comprovante ${created.id} falhou: ${err?.message ?? err}`,
      );
    }

    const updated = await this.prisma.tinyReceipt.update({
      where: { id: created.id },
      data: result?.ok
        ? {
            ehComprovante: result.ehComprovante,
            valor:
              result.valor != null
                ? new Prisma.Decimal(result.valor)
                : null,
            metodo: result.metodo,
            parcelas: result.parcelas,
            dataPagamento: result.data,
            observacao: result.observacao,
            statusExtracao: 'ok',
            extraidoEm: new Date(),
          }
        : { statusExtracao: 'falhou', extraidoEm: new Date() },
    });

    return this.serialize(updated);
  }

  /** Edita manualmente os campos extraídos (marca statusExtracao='manual'). */
  async update(
    organizationId: string,
    docId: string,
    receiptId: string,
    dto: {
      valor?: number | null;
      metodo?: string | null;
      parcelas?: number | null;
      dataPagamento?: string | null;
    },
  ) {
    await this.assertDoc(organizationId, docId);
    const existing = await this.prisma.tinyReceipt.findFirst({
      where: { id: receiptId, tinyDocumentId: docId, organizationId },
      select: { id: true },
    });
    if (!existing) throw new NotFoundException('Comprovante não encontrado');

    const data: Prisma.TinyReceiptUpdateInput = { statusExtracao: 'manual' };
    if (dto.valor !== undefined) {
      data.valor = dto.valor != null ? new Prisma.Decimal(dto.valor) : null;
    }
    if (dto.metodo !== undefined) {
      data.metodo = dto.metodo ? this.normalizeMetodo(dto.metodo) : null;
    }
    if (dto.parcelas !== undefined) data.parcelas = dto.parcelas ?? null;
    if (dto.dataPagamento !== undefined) {
      const d = dto.dataPagamento ? new Date(dto.dataPagamento) : null;
      data.dataPagamento = d && !isNaN(d.getTime()) ? d : null;
    }

    const updated = await this.prisma.tinyReceipt.update({
      where: { id: receiptId },
      data,
    });
    return this.serialize(updated);
  }

  async remove(organizationId: string, docId: string, receiptId: string) {
    await this.assertDoc(organizationId, docId);
    const res = await this.prisma.tinyReceipt.deleteMany({
      where: { id: receiptId, tinyDocumentId: docId, organizationId },
    });
    if (res.count === 0) throw new NotFoundException('Comprovante não encontrado');
    return { ok: true };
  }

  // ── IA ───────────────────────────────────────────────────────────────

  /** Chama a visão da Anthropic pra extrair os dados do comprovante. */
  private async extract(
    organizationId: string,
    buffer: Buffer,
    mimetype: string,
  ): Promise<ExtractResult> {
    const mediaPart = this.buildMediaPart(buffer, mimetype);
    if (!mediaPart) {
      // Tipo não suportado pela visão (ex.: heic) → extração falha, preenche à mão.
      return this.emptyResult(false);
    }

    const tool: LlmToolDefinition = {
      name: 'registrar_comprovante',
      description:
        'Registra os dados extraídos de um comprovante de pagamento brasileiro.',
      parameters: {
        type: 'object',
        properties: {
          ehComprovante: {
            type: 'boolean',
            description:
              'true se o arquivo é claramente um comprovante/recibo de pagamento',
          },
          valor: {
            type: ['number', 'null'],
            description:
              'valor pago em reais como número (ex: 1234.56). null se não encontrar.',
          },
          metodo: {
            type: 'string',
            enum: [...METODOS],
            description: 'forma de pagamento identificada',
          },
          parcelas: {
            type: ['integer', 'null'],
            description: 'número de parcelas quando parcelado; senão null',
          },
          data: {
            type: ['string', 'null'],
            description: 'data do pagamento no formato YYYY-MM-DD; null se não achar',
          },
          observacao: {
            type: ['string', 'null'],
            description:
              'observação curta (banco/origem) ou o motivo se não for um comprovante',
          },
        },
        required: ['ehComprovante', 'metodo'],
      },
    };

    const content: LlmContentPart[] = [
      mediaPart,
      {
        type: 'text',
        text:
          'Este arquivo deveria ser um comprovante de pagamento (Pix, cartão, ' +
          'parcelamento, boleto, transferência...). Leia e chame a ferramenta ' +
          'registrar_comprovante com os dados. O valor é sempre um número em ' +
          'reais. Se NÃO for um comprovante de pagamento, use ehComprovante=false.',
      },
    ];

    const resp = await this.llm.complete({
      modelId: EXTRACTION_MODEL,
      organizationId,
      temperature: 0,
      maxTokens: 500,
      messages: [{ role: 'user', content }],
      tools: [tool],
    });

    const call = resp.message.toolCalls?.find(
      (t) => t.name === 'registrar_comprovante',
    );
    if (!call) return this.emptyResult(false);

    const a = call.arguments as Record<string, any>;
    const valor = this.toNumber(a.valor);
    const dataStr = typeof a.data === 'string' ? a.data : null;
    const dt = dataStr ? new Date(dataStr) : null;

    return {
      ehComprovante:
        typeof a.ehComprovante === 'boolean' ? a.ehComprovante : null,
      valor,
      metodo: this.normalizeMetodo(a.metodo),
      parcelas: Number.isFinite(Number(a.parcelas))
        ? Math.trunc(Number(a.parcelas))
        : null,
      data: dt && !isNaN(dt.getTime()) ? dt : null,
      observacao:
        typeof a.observacao === 'string' && a.observacao.trim()
          ? a.observacao.trim().slice(0, 500)
          : null,
      ok: true,
    };
  }

  private buildMediaPart(
    buffer: Buffer,
    mimetype: string,
  ): LlmContentPart | null {
    const mime = (mimetype || '').toLowerCase();
    const base64 = buffer.toString('base64');
    if (mime === 'application/pdf') {
      return { type: 'document', base64: { mediaType: 'application/pdf', data: base64 } };
    }
    const visionMime = VISION_IMAGE_MIME[mime];
    if (visionMime) {
      return { type: 'image', base64: { mediaType: visionMime, data: base64 } };
    }
    return null;
  }

  private emptyResult(ok: boolean): ExtractResult {
    return {
      ehComprovante: null,
      valor: null,
      metodo: null,
      parcelas: null,
      data: null,
      observacao: null,
      ok,
    };
  }

  private toNumber(v: unknown): number | null {
    if (v == null) return null;
    const n = typeof v === 'string' ? Number(v.replace(/[^\d.,-]/g, '').replace(',', '.')) : Number(v);
    return Number.isFinite(n) ? n : null;
  }

  private normalizeMetodo(v: unknown): string | null {
    if (!v) return null;
    const s = String(v).toLowerCase().trim();
    return (METODOS as readonly string[]).includes(s) ? s : 'outro';
  }

  private serialize(r: {
    id: string;
    url: string;
    mimeType: string | null;
    fileName: string | null;
    valor: Prisma.Decimal | null;
    metodo: string | null;
    parcelas: number | null;
    dataPagamento: Date | null;
    ehComprovante: boolean | null;
    statusExtracao: string | null;
    observacao: string | null;
    createdAt: Date;
  }) {
    return {
      id: r.id,
      url: r.url,
      mimeType: r.mimeType,
      fileName: r.fileName,
      valor: r.valor != null ? Number(r.valor) : null,
      metodo: r.metodo,
      parcelas: r.parcelas,
      dataPagamento: r.dataPagamento ? r.dataPagamento.toISOString() : null,
      ehComprovante: r.ehComprovante,
      statusExtracao: r.statusExtracao,
      observacao: r.observacao,
      createdAt: r.createdAt.toISOString(),
    };
  }
}
