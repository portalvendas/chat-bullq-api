import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from '../../../../database/prisma.service';
import { EnrichedContext } from './long-term.types';
import { LongTermMemoryService } from './long-term.service';

/**
 * Builds the Layer-4 context payload that the prompt composer (Agent 3)
 * splices into the system prompt. Gathers contact data, channel info,
 * recent messages and the long-term memory for (agent, contact) — all in
 * parallel queries — and returns a flat, prompt-friendly object.
 *
 * Note: this service intentionally does no formatting. The composer is
 * responsible for turning the `EnrichedContext` into prose.
 */
@Injectable()
export class ContextEnrichmentService {
  private readonly logger = new Logger(ContextEnrichmentService.name);

  // Default timezone for our Brazil-only product. Override via env later
  // if/when we go multi-region.
  private static readonly DEFAULT_TZ = 'America/Sao_Paulo';

  constructor(
    private readonly prisma: PrismaService,
    private readonly memory: LongTermMemoryService,
  ) {}

  async enrich(input: {
    agentId: string;
    conversationId: string;
    contactId: string;
    /** Optional cap on recent messages — defaults to 30. */
    recentMessageLimit?: number;
  }): Promise<EnrichedContext> {
    const limit = input.recentMessageLimit ?? 30;

    const [contact, conversation, messages, mem] = await Promise.all([
      this.prisma.contact.findUnique({ where: { id: input.contactId } }),
      this.prisma.conversation.findUnique({
        where: { id: input.conversationId },
        include: { channel: true },
      }),
      this.prisma.message.findMany({
        where: { conversationId: input.conversationId },
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      this.memory.findOne(input.agentId, input.contactId),
    ]);

    return {
      contact: {
        name: contact?.name ?? undefined,
        email: contact?.email ?? undefined,
        phone: contact?.phone ?? undefined,
        tags: [],
      },
      channel: this.mapChannel(conversation?.channel),
      time: {
        nowIso: new Date().toISOString(),
        timezone: ContextEnrichmentService.DEFAULT_TZ,
        businessHours: this.isBusinessHours(),
      },
      memory: mem
        ? {
            summary: mem.summary ?? undefined,
            facts: mem.facts.map((f) => f.fact),
          }
        : undefined,
      // Catalog enrichment will plug in here once Agent 4's catalog service
      // is wired up — leaving undefined so the composer can decide how to
      // render the absence.
      catalog: undefined,
      recentMessages: messages
        .slice()
        .reverse()
        .map((m) => ({
          role: (m.direction === 'INBOUND' ? 'user' : 'assistant') as
            | 'user'
            | 'assistant'
            | 'tool',
          content: this.extractMessageText(m.content),
        }))
        .filter((m) => m.content.trim().length > 0),
    };
  }

  // ─── helpers ─────────────────────────────────────────────────────────

  /**
   * 09h–19h America/Sao_Paulo, Mon-Fri. Used by the prompt composer to add
   * "we're outside business hours" context — not used to gate anything.
   */
  private isBusinessHours(): boolean {
    const now = new Date();
    // toLocaleString in en-US gives us a parseable "M/D/YYYY, HH:mm:ss" — we
    // only need the hour and the weekday, both of which Date can compute
    // correctly with the formatter applied.
    const localHour = Number(
      now.toLocaleString('en-US', {
        timeZone: ContextEnrichmentService.DEFAULT_TZ,
        hour: '2-digit',
        hour12: false,
      }),
    );
    const localWeekday = now.toLocaleString('en-US', {
      timeZone: ContextEnrichmentService.DEFAULT_TZ,
      weekday: 'short',
    });
    const isWeekday = !['Sat', 'Sun'].includes(localWeekday);
    return isWeekday && localHour >= 9 && localHour < 19;
  }

  private mapChannel(channel: {
    type: string;
    name: string;
  } | null | undefined): EnrichedContext['channel'] {
    if (!channel) {
      return { kind: 'WEB', name: 'unknown' };
    }
    const kind: EnrichedContext['channel']['kind'] =
      channel.type === 'INSTAGRAM'
        ? 'INSTAGRAM'
        : channel.type === 'WHATSAPP_OFFICIAL' ||
            channel.type === 'WHATSAPP_ZAPPFY'
          ? 'WHATSAPP'
          : 'WEB';
    return { kind, name: channel.name };
  }

  private extractMessageText(content: unknown): string {
    if (!content || typeof content !== 'object') return '';
    const c = content as Record<string, unknown>;
    if (typeof c.text === 'string') return c.text;
    if (typeof c.body === 'string') return c.body;
    if (typeof c.caption === 'string') return c.caption;
    return '';
  }
}
