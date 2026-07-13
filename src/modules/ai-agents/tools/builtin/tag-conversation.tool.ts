import { Injectable, Logger } from '@nestjs/common';
import { AutomationTrigger, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { OutboxService } from '../../../automations/outbox/outbox.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

/**
 * Tags a conversation with one or more labels. If a tag name doesn't exist
 * in the org yet, it is created. Existing tags are reused.
 *
 * Each NEWLY applied (tag,conversation) pair emits a TAG_ADDED outbox
 * event so workspace automations can react to AI-driven tagging the same
 * way they react to manual tagging from the UI.
 */
@Injectable()
export class TagConversationTool implements AiTool {
  private readonly logger = new Logger(TagConversationTool.name);

  readonly name = 'tagConversation';
  readonly description =
    'Apply one or more tags to the current conversation. Use to categorize the request (ex: "billing", "lead-quente", "duvida-tecnica") so it can be filtered/reported on later.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['tags'],
    properties: {
      tags: {
        type: 'array',
        items: { type: 'string', minLength: 1, maxLength: 40 },
        minItems: 1,
        maxItems: 5,
        description:
          'Tag names (lowercase, kebab-case preferred). New names are auto-created.',
      },
    },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Normaliza `tags` de forma tolerante ao modelo. O ideal é um array de
   * strings, mas modelos (sobretudo o Haiku) às vezes serializam torto e
   * mandam uma STRING tipo `mercado-livre-ml", "colmeia-mdf", "x"]` ou um
   * JSON `["a","b"]`. Aceitamos: array; JSON de array; ou string separada
   * por vírgula — limpando aspas/colchetes das pontas de cada item.
   */
  private coerceTags(value: unknown): string[] {
    if (Array.isArray(value)) return value.map((v) => String(v));
    if (typeof value !== 'string') return [];

    let s = value.trim();
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed.map((v) => String(v));
      if (typeof parsed === 'string') s = parsed;
    } catch {
      /* não é JSON válido — cai no split abaixo */
    }
    // Remove colchetes das pontas e divide por vírgula, limpando aspas/colchetes.
    return s
      .replace(/^\s*\[/, '')
      .replace(/\]\s*$/, '')
      .split(',')
      .map((t) => t.replace(/["'\[\]]/g, '').trim())
      .filter((t) => t.length > 0);
  }

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const raw = this.coerceTags(input.tags);
    const names = Array.from(
      new Set(
        raw
          .map((t) => String(t).trim().toLowerCase())
          .filter((t) => t.length > 0 && t.length <= 40),
      ),
    ).slice(0, 5);

    if (names.length === 0) {
      return { output: { ok: false, error: 'no valid tag names' } };
    }

    const existing = await this.prisma.tag.findMany({
      where: { organizationId: ctx.organizationId, name: { in: names } },
      select: { id: true, name: true },
    });
    const existingByName = new Map(existing.map((t) => [t.name, t.id]));
    const toCreate = names.filter((n) => !existingByName.has(n));

    const created = toCreate.length
      ? await this.prisma.$transaction(
          toCreate.map((name) =>
            this.prisma.tag.create({
              data: { organizationId: ctx.organizationId, name },
              select: { id: true, name: true },
            }),
          ),
        )
      : [];

    const allTags = [...existing, ...created];

    // Apply each tag inside its own TX so the outbox emit is atomic with
    // the link creation. Use `create` + P2002 catch (instead of upsert)
    // so we know which tags were genuinely new — only those should fire
    // a TAG_ADDED event. Re-applying an existing tag is a no-op for the
    // automation engine.
    for (const tag of allTags) {
      try {
        await this.prisma.$transaction(async (tx) => {
          await tx.conversationTag.create({
            data: {
              conversationId: ctx.conversationId,
              tagId: tag.id,
            },
          });
          await this.outbox.enqueue(tx, AutomationTrigger.TAG_ADDED, {
            organizationId: ctx.organizationId,
            contactId: ctx.contactId,
            conversationId: ctx.conversationId,
            channelId: ctx.channelId,
            actorId: ctx.agentId, // attribution: AI agent that tagged
            tagId: tag.id,
            target: 'conversation',
          });
        });
      } catch (err) {
        // Tag already on this conversation — silent no-op. We don't want
        // to spam the run log with "duplicate" errors for re-applies.
        if (
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002'
        ) {
          continue;
        }
        throw err;
      }
    }

    this.logger.log(
      `Agent ${ctx.agentId} tagged conv ${ctx.conversationId} with ${names.join(', ')}`,
    );

    return {
      output: {
        ok: true,
        applied: allTags.map((t) => t.name),
      },
    };
  }
}
