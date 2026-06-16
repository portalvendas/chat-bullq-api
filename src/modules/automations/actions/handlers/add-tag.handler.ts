import { Injectable } from '@nestjs/common';
import { AutomationTrigger, Prisma } from '@prisma/client';
import {
  ActionContext,
  ActionExecutionResult,
  ActionHandler,
} from '../action.types';

interface AddTagParams {
  tagId: string;
  // Where to apply: conversation (ConversationTag) or contact (ContactTag).
  // Defaults to conversation when the event has a conversationId, else
  // contact. Explicit is better — UI should always set this.
  target?: 'conversation' | 'contact';
}

@Injectable()
export class AddTagHandler implements ActionHandler {
  readonly type = 'add_tag' as const;
  // State-changing action — by default, halt the run on failure so we
  // don't keep running downstream actions on inconsistent state.
  readonly continueOnErrorDefault = false;

  validateParams(params: Record<string, unknown>): void {
    if (!params.tagId || typeof params.tagId !== 'string') {
      throw new Error('add_tag: param "tagId" is required (string)');
    }
    if (
      params.target !== undefined &&
      params.target !== 'conversation' &&
      params.target !== 'contact'
    ) {
      throw new Error('add_tag: "target" must be conversation | contact');
    }
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ActionContext,
  ): Promise<ActionExecutionResult> {
    const p = params as unknown as AddTagParams;
    const { organizationId, payload, prisma, outbox } = ctx;

    // Validate tag belongs to org — defense against stale config
    // referencing a tag deleted/moved after the rule was saved.
    const tag = await prisma.tag.findFirst({
      where: { id: p.tagId, organizationId },
      select: { id: true },
    });
    if (!tag) {
      return {
        ok: false,
        errorCode: 'invalid_ref',
        errorMessage: `tag ${p.tagId} not found in org`,
      };
    }

    const target = p.target ?? (payload.conversationId ? 'conversation' : 'contact');

    try {
      if (target === 'conversation') {
        if (!payload.conversationId) {
          return {
            ok: false,
            errorCode: 'invalid_params',
            errorMessage: 'add_tag target=conversation but event has no conversationId',
          };
        }
        // Single TX so the cascade event is in the outbox iff the tag
        // attach committed. Same pattern as the user-facing TagsService.
        await prisma.$transaction(async (tx) => {
          await tx.conversationTag.create({
            data: { conversationId: payload.conversationId!, tagId: p.tagId },
          });
          await outbox.enqueue(
            tx,
            AutomationTrigger.TAG_ADDED,
            {
              organizationId,
              contactId: payload.contactId,
              conversationId: payload.conversationId,
              channelId: payload.channelId,
              actorId: ctx.actorId,
              tagId: p.tagId,
              target: 'conversation',
            },
            {
              traceId: ctx.traceId,
              cascadeDepth: ctx.cascadeDepth,
            },
          );
        });
      } else {
        await prisma.$transaction(async (tx) => {
          await tx.contactTag.create({
            data: { contactId: payload.contactId, tagId: p.tagId },
          });
          await outbox.enqueue(
            tx,
            AutomationTrigger.TAG_ADDED,
            {
              organizationId,
              contactId: payload.contactId,
              actorId: ctx.actorId,
              tagId: p.tagId,
              target: 'contact',
            },
            {
              traceId: ctx.traceId,
              cascadeDepth: ctx.cascadeDepth,
            },
          );
        });
      }
      return { ok: true, output: { target, tagId: p.tagId } };
    } catch (err) {
      // Idempotent path: tag already there → success. Without this, every
      // retry of a successful run would log "failed" even though state
      // is correct.
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return { ok: true, output: { target, tagId: p.tagId, alreadyApplied: true } };
      }
      return {
        ok: false,
        errorCode: 'unexpected',
        errorMessage: (err as Error).message,
      };
    }
  }
}
