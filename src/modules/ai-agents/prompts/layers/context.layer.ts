import { Injectable, Logger } from '@nestjs/common';
import { EnrichedContext, PromptLayer } from '../types';

/**
 * Layer 4 — CONTEXT (dinâmico)
 *
 * Monta a seção do prompt com dados frescos da conversa atual:
 *   - Cliente (nome, email, telefone, tags)
 *   - Canal (kind + nome)
 *   - Hora local + timezone + se está em horário comercial
 *   - Memória (summary + facts)
 *   - Catálogo compactado da org
 *
 * Não inclui as `recentMessages` no system prompt — essas vão como
 * mensagens role=user/assistant separadas pro LLM (responsabilidade do
 * runner, não desta layer).
 *
 * Função 100% pura: recebe `EnrichedContext`, devolve `PromptLayer`.
 * Sem DB, sem I/O, sem dependência do Prisma. O Agent 8 (Context Enricher)
 * é quem faz a coleta — esta layer só formata.
 */

@Injectable()
export class ContextLayerService {
  private readonly logger = new Logger(ContextLayerService.name);

  build(ctx: EnrichedContext): PromptLayer {
    const sections: string[] = [];

    sections.push('=== CONTEXTO DA CONVERSA ===');

    // ─── Cliente ───
    const contactLines: string[] = [];
    const name = ctx.contact.name?.trim();
    const phone = ctx.contact.phone?.trim();
    const email = ctx.contact.email?.trim();

    contactLines.push(`Cliente: ${name || 'sem nome cadastrado'}`);
    if (phone) contactLines.push(`Telefone: ${phone}`);
    if (email) contactLines.push(`E-mail: ${email}`);
    if (ctx.contact.tags && ctx.contact.tags.length > 0) {
      contactLines.push(`Tags: ${ctx.contact.tags.join(', ')}`);
    }
    sections.push(contactLines.join('\n'));

    // ─── Canal ───
    sections.push('');
    sections.push(`Canal: ${ctx.channel.kind} - ${ctx.channel.name}`);

    // ─── Tempo ───
    sections.push('');
    sections.push(this.formatTime(ctx.time));

    // ─── Memória ───
    const hasMemorySummary = (ctx.memory?.summary ?? '').trim().length > 0;
    const hasMemoryFacts = (ctx.memory?.facts?.length ?? 0) > 0;
    if (hasMemorySummary || hasMemoryFacts) {
      sections.push('');
      sections.push('=== MEMÓRIA SOBRE ESTE CLIENTE ===');
      if (hasMemorySummary) {
        sections.push((ctx.memory!.summary ?? '').trim());
      }
      if (hasMemoryFacts) {
        sections.push('');
        sections.push('Fatos:');
        for (const fact of ctx.memory!.facts ?? []) {
          sections.push(`- ${fact}`);
        }
      }
    }

    // ─── Catálogo ───
    if (ctx.catalog && ctx.catalog.products.length > 0) {
      sections.push('');
      sections.push('=== CATÁLOGO (use APENAS o que está aqui) ===');
      sections.push(
        'Pra preço, link e condições, chame a skill de pitch passando o slug. NUNCA invente valor, prazo ou link.',
      );

      // Agrupa por categoria pra leitura mais limpa.
      type CatalogProduct = NonNullable<
        EnrichedContext['catalog']
      >['products'][number];
      const byCat = new Map<string, CatalogProduct[]>();
      for (const p of ctx.catalog.products) {
        const cat = p.category?.trim() || 'Outros';
        const list = byCat.get(cat) ?? [];
        list.push(p);
        byCat.set(cat, list);
      }
      for (const [cat, items] of byCat) {
        sections.push('');
        sections.push(`# ${cat}`);
        for (const p of items) {
          sections.push(`- \`${p.slug}\` · ${p.name} — ${p.tagline}`);
        }
      }
    }

    sections.push('');
    sections.push(
      'USE ESTES DADOS REAIS. Não invente nome, telefone, fato sobre o cliente nem item de catálogo.',
    );

    const content = sections.join('\n');
    const tokenEstimate = Math.ceil(content.length / 4);

    this.logger.debug(
      {
        event: 'context_layer_built',
        tokenEstimate,
        hasMemory: hasMemorySummary || hasMemoryFacts,
        catalogSize: ctx.catalog?.products.length ?? 0,
      },
      'Context layer built',
    );

    return {
      kind: 'context',
      content,
      tokenEstimate,
    };
  }

  /**
   * Formata o bloco temporal — tenta usar Intl pro local correto, com
   * fallback pra ISO bruto se a TZ for inválida (defensivo, mas a
   * normalização real é responsabilidade do Agent 8).
   */
  private formatTime(time: EnrichedContext['time']): string {
    let humanTime: string;
    try {
      humanTime = new Intl.DateTimeFormat('pt-BR', {
        timeZone: time.timezone,
        dateStyle: 'full',
        timeStyle: 'short',
      }).format(new Date(time.nowIso));
    } catch {
      humanTime = time.nowIso;
    }
    const hours = time.businessHours
      ? 'dentro do horário comercial'
      : 'fora do horário comercial';
    return `Agora: ${humanTime} (${time.timezone}, ${hours})`;
  }
}

/**
 * Helper funcional.
 */
export function buildContextLayer(ctx: EnrichedContext): PromptLayer {
  return new ContextLayerService().build(ctx);
}
