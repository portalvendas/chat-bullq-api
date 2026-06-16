import { Injectable } from '@nestjs/common';
import {
  AutomationTrigger,
  ConversationStatus,
  OrgRole,
} from '@prisma/client';
import {
  ActionContext,
  ActionExecutionResult,
  ActionHandler,
} from '../action.types';

interface AssignUserParams {
  userId: string;
}

@Injectable()
export class AssignUserHandler implements ActionHandler {
  readonly type = 'assign_user' as const;
  readonly continueOnErrorDefault = false;

  validateParams(params: Record<string, unknown>): void {
    if (!params.userId || typeof params.userId !== 'string') {
      throw new Error('assign_user: "userId" is required (string)');
    }
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ActionContext,
  ): Promise<ActionExecutionResult> {
    const p = params as unknown as AssignUserParams;
    const { organizationId, payload, prisma, outbox } = ctx;

    if (!payload.conversationId) {
      return {
        ok: false,
        errorCode: 'invalid_params',
        errorMessage: 'assign_user requires a conversationId in the event',
      };
    }

    // Validate the assignee is still a member of the org. A removed user
    // would still pass FK (since users live forever) but assigning to
    // someone outside the workspace is a permission leak.
    const membership = await prisma.userOrganization.findFirst({
      where: {
        userId: p.userId,
        organizationId,
      },
      select: { id: true, role: true },
    });
    if (!membership) {
      return {
        ok: false,
        errorCode: 'invalid_ref',
        errorMessage: `user ${p.userId} is not a member of this org`,
      };
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: payload.conversationId, organizationId },
    });
    if (!conversation) {
      return {
        ok: false,
        errorCode: 'invalid_ref',
        errorMessage: 'conversation not found in org',
      };
    }

    // No-op short circuit. Without this, every fire of the rule on the
    // same conversation would emit a CONVERSATION_ASSIGNED event and
    // potentially trigger downstream automations indefinitely.
    if (conversation.assignedToId === p.userId) {
      return { ok: true, output: { alreadyAssigned: true, userId: p.userId } };
    }

    const willAlsoChangeStatus =
      conversation.status === ConversationStatus.PENDING;

    try {
      await prisma.$transaction(async (tx) => {
        const updates: Record<string, unknown> = { assignedToId: p.userId };
        if (willAlsoChangeStatus) {
          updates.status = ConversationStatus.OPEN;
          if (!conversation.firstResponseAt) {
            updates.firstResponseAt = new Date();
          }
        }
        await tx.conversation.update({
          where: { id: conversation.id },
          data: updates,
        });
        await tx.conversationAuditLog.create({
          data: {
            conversationId: conversation.id,
            actorId: ctx.actorId,
            action: 'ASSIGNED',
            fromValue: conversation.assignedToId,
            toValue: p.userId,
            metadata: { source: 'automation', traceId: ctx.traceId },
          },
        });
        if (willAlsoChangeStatus) {
          await tx.conversationAuditLog.create({
            data: {
              conversationId: conversation.id,
              actorId: ctx.actorId,
              action: 'STATUS_CHANGED',
              fromValue: ConversationStatus.PENDING,
              toValue: ConversationStatus.OPEN,
              metadata: { source: 'automation', traceId: ctx.traceId },
            },
          });
        }
        await outbox.enqueue(
          tx,
          AutomationTrigger.CONVERSATION_ASSIGNED,
          {
            organizationId,
            contactId: conversation.contactId,
            conversationId: conversation.id,
            channelId: conversation.channelId,
            actorId: ctx.actorId,
            fromAssigneeId: conversation.assignedToId,
            toAssigneeId: p.userId,
          },
          { traceId: ctx.traceId, cascadeDepth: ctx.cascadeDepth },
        );
        if (willAlsoChangeStatus) {
          await outbox.enqueue(
            tx,
            AutomationTrigger.CONVERSATION_STATUS_CHANGED,
            {
              organizationId,
              contactId: conversation.contactId,
              conversationId: conversation.id,
              channelId: conversation.channelId,
              actorId: ctx.actorId,
              fromStatus: ConversationStatus.PENDING,
              toStatus: ConversationStatus.OPEN,
            },
            { traceId: ctx.traceId, cascadeDepth: ctx.cascadeDepth },
          );
        }
      });

      // Membership ref is unused after the check, but kept here for
      // clarity that we did validate role-bearing membership before
      // flipping assignedToId.
      void membership;
      void OrgRole;

      return { ok: true, output: { userId: p.userId } };
    } catch (err) {
      return {
        ok: false,
        errorCode: 'unexpected',
        errorMessage: (err as Error).message,
      };
    }
  }
}
