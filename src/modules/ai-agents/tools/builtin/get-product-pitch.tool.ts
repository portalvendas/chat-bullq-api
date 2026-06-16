import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

/**
 * Returns the full pitch + price + checkout link for a product owned by
 * the org. Sales agents see a compact list of all products in their
 * system prompt and call this skill with a slug when actually
 * recommending — keeps the prompt small while letting the agent
 * pull authoritative copy on demand instead of inventing.
 *
 * Backend source: Trivapp (members area). Each tenant in Trivapp owns
 * its sales offers under /api/v1/catalog/:slug. Auth via
 * x-admin-api-key + x-tenant-id headers (same pattern admin-actions).
 *
 * Env required:
 * - MEMBERS_TRIVAPP_URL (default https://api.trivapp.com.br)
 * - MEMBERS_ADMIN_KEY
 * - MEMBERS_TENANT_BRAVY (TODO: per-org mapping when multi-tenant)
 */
@Injectable()
export class GetProductPitchTool implements AiTool {
  private readonly logger = new Logger(GetProductPitchTool.name);

  // Nome neutro a propósito — a LLM tem tendência a "ecoar" o nome da
  // tool nas mensagens ao cliente. Nomes como `getProductPitch` faziam
  // ela soltar "vou te mandar o pitch" / "tem no catálogo". Renomeado
  // pra `lookupOffering` (e a description não usa pitch/catálogo/pack)
  // pra ela falar como gente.
  readonly name = 'lookupOffering';
  readonly description =
    'Busca os detalhes oficiais (preço, condições, link de pagamento, principais entregas) do que pode resolver pro cliente. SEMPRE use isto ANTES de citar valor, prazo ou link — nunca invente. Slug vem da lista de soluções no system prompt.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['slug'],
    properties: {
      slug: {
        type: 'string',
        description:
          'Identificador da solução (ex: "maestria"). Lista disponível na seção "Soluções que oferecemos" do system prompt.',
        minLength: 1,
        maxLength: 80,
      },
    },
  };

  constructor(private readonly config: ConfigService) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const slug = String(input.slug ?? '').trim().toLowerCase();
    if (!slug) {
      return { output: { ok: false, error: 'slug obrigatório' } };
    }

    const baseUrl =
      this.config.get<string>('MEMBERS_TRIVAPP_URL') ??
      'https://api.trivapp.com.br';
    const apiKey = this.config.get<string>('MEMBERS_ADMIN_KEY');
    const tenantId = this.config.get<string>('MEMBERS_TENANT_BRAVY');

    if (!apiKey || !tenantId) {
      this.logger.warn(
        'Trivapp credentials missing (MEMBERS_ADMIN_KEY / MEMBERS_TENANT_BRAVY)',
      );
      return {
        output: {
          ok: false,
          error: 'Trivapp não configurado no servidor — fale com o admin',
        },
      };
    }

    try {
      const resp = await axios.get(`${baseUrl}/api/v1/catalog/${slug}`, {
        headers: {
          'x-admin-api-key': apiKey,
          'x-tenant-id': tenantId,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      });

      this.logger.log(
        `getProductPitch served ${slug} (org=${ctx.organizationId})`,
      );

      return { output: { ok: true, product: resp.data } };
    } catch (err: any) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.message ?? err?.message;
      this.logger.warn(
        `getProductPitch failed for ${slug}: ${status ?? '?'} ${detail}`,
      );
      if (status === 404) {
        return {
          output: {
            ok: false,
            error: `Solução "${slug}" não encontrada. Confira os slugs na seção "Soluções que oferecemos" do system prompt.`,
          },
        };
      }
      return {
        output: {
          ok: false,
          error: `Falha ao buscar detalhes da solução: ${detail}`,
        },
      };
    }
  }
}
