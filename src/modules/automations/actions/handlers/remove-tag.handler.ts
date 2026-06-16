import { Injectable } from '@nestjs/common';
import { AutomationTrigger, Prisma } from '@prisma/client';
import {
  ActionContext,
  ActionExecutionResult,
  ActionHandler,
} from '../action.types';

interface RemoveTagParams {
  tagId: string;
  target?: 'conversation' | 'contact';
}

@Injectable()
export class RemoveTagHandler implements ActionHandler {
  readonly type = 'remove_tag' as const;
  readonly continueOnErrorDefault = false;

  validateParams(params: Record<string, unknown>): void {
    if (!params.tagId || typeof params.tagId !== 'string') {
      throw new Error('remove_tag: param "tagId" is required (string)');
    }
    if (
      params.target !== undefined &&
      params.target !== 'conversation' &&
      params.target !== 'contact'
    ) {
      throw new Error('remove_tag: "target" must be conversation | contact');
    }
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ActionContext,
  ): Promise<ActionExecutionResult> {
    const p = params as unknown as RemoveTagParams;
    const { organizationId, payload, prisma, outbox } = ctx;

    const target =
      p.target ?? (payload.conversationId ? 'conversation' : 'contact');

    try {
      if (target === 'conversation') {
        if (!payload.conversationId) {
          return {
            ok: false,
            errorCode: 'invalid_params',
            errorMessage: 'remove_tag target=conversation but event has no conversationId',
          };
        }
        await prisma.$transaction(async (tx) => {
          await tx.conversationTag.delete({
            where: {
              conversationId_tagId: {
                conversationId: payload.conversationId!,
                tagId: p.tagId,
              },
            },
          });
          await outbox.enqueue(
            tx,
            AutomationTrigger.TAG_REMOVED,
            {
              organizationId,
              contactId: payload.contactId,
              conversationId: payload.conversationId,
              channelId: payload.channelId,
              actorId: ctx.actorId,
              tagId: p.tagId,
              target: 'conversation',
            },
            { traceId: ctx.traceId, cascadeDepth: ctx.cascadeDepth },
          );
        });
      } else {
        await prisma.$transaction(async (tx) => {
          await tx.contactTag.delete({
            where: {
              contactId_tagId: {
                contactId: payload.contactId,
                tagId: p.tagId,
              },
            },
          });
          await outbox.enqueue(
            tx,
            AutomationTrigger.TAG_REMOVED,
            {
              organizationId,
              contactId: payload.contactId,
              actorId: ctx.actorId,
              tagId: p.tagId,
              target: 'contact',
            },
            { traceId: ctx.traceId, cascadeDepth: ctx.cascadeDepth },
          );
        });
      }
      return { ok: true, output: { target, tagId: p.tagId } };
    } catch (err) {
      // Tag wasn't there → success (idempotent removal).
      if (
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2025'
      ) {
        return { ok: true, output: { target, tagId: p.tagId, notPresent: true } };
      }
      return {
        ok: false,
        errorCode: 'unexpected',
        errorMessage: (err as Error).message,
      };
    }
  }
}
