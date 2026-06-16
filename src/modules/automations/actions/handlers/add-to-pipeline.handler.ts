import { Injectable } from '@nestjs/common';
import {
  ActionContext,
  ActionExecutionResult,
  ActionHandler,
} from '../action.types';

interface AddToPipelineParams {
  pipelineId: string;
  // Optional: which stage to drop the card on. Defaults to the first
  // stage (lowest order) of NORMAL type. UI usually doesn't ask the user
  // about this — "send to pipeline X" is intuitive, "send to stage Y" is
  // configuration the rule author shouldn't worry about.
  stageId?: string;
  // Optional override for the card title. Defaults to contact name or
  // a fallback. Free-form templates (with {{contact.name}} etc.) are
  // intentionally NOT supported in PR2 — too much surface for too little
  // value. Add later if real demand shows up.
  title?: string;
}

@Injectable()
export class AddToPipelineHandler implements ActionHandler {
  readonly type = 'add_to_pipeline' as const;
  readonly continueOnErrorDefault = false;

  validateParams(params: Record<string, unknown>): void {
    if (!params.pipelineId || typeof params.pipelineId !== 'string') {
      throw new Error('add_to_pipeline: param "pipelineId" is required (string)');
    }
    if (params.stageId !== undefined && typeof params.stageId !== 'string') {
      throw new Error('add_to_pipeline: "stageId" must be a string when provided');
    }
    if (params.title !== undefined && typeof params.title !== 'string') {
      throw new Error('add_to_pipeline: "title" must be a string when provided');
    }
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ActionContext,
  ): Promise<ActionExecutionResult> {
    const p = params as unknown as AddToPipelineParams;
    const { organizationId, payload, prisma } = ctx;

    const pipeline = await prisma.pipeline.findFirst({
      where: { id: p.pipelineId, organizationId, archived: false },
      include: {
        stages: { orderBy: { order: 'asc' } },
      },
    });
    if (!pipeline) {
      return {
        ok: false,
        errorCode: 'invalid_ref',
        errorMessage: `pipeline ${p.pipelineId} not found in org`,
      };
    }

    const stage = p.stageId
      ? pipeline.stages.find((s) => s.id === p.stageId)
      : pipeline.stages.find((s) => s.type === 'NORMAL') ?? pipeline.stages[0];
    if (!stage) {
      return {
        ok: false,
        errorCode: 'invalid_ref',
        errorMessage: 'pipeline has no usable stage',
      };
    }

    // Idempotency check: if this contact already has an OPEN card in this
    // pipeline, do nothing. Otherwise the same lead would accumulate
    // duplicate cards every time the rule fires (each new tag/message).
    const existing = await prisma.card.findFirst({
      where: {
        organizationId,
        pipelineId: pipeline.id,
        contactId: payload.contactId,
        status: 'OPEN',
      },
      select: { id: true },
    });
    if (existing) {
      return { ok: true, output: { cardId: existing.id, alreadyExists: true } };
    }

    const contact = await prisma.contact.findFirst({
      where: { id: payload.contactId, organizationId },
      select: { name: true, phone: true },
    });
    const title =
      p.title ??
      contact?.name ??
      contact?.phone ??
      `Lead ${payload.contactId.slice(0, 8)}`;

    try {
      const card = await prisma.card.create({
        data: {
          organizationId,
          pipelineId: pipeline.id,
          stageId: stage.id,
          title,
          contactId: payload.contactId,
          conversationId: payload.conversationId ?? null,
          status: 'OPEN',
          metadata: {
            createdBy: 'automation',
            traceId: ctx.traceId,
          },
        },
      });
      return {
        ok: true,
        output: { cardId: card.id, pipelineId: pipeline.id, stageId: stage.id },
      };
    } catch (err) {
      return {
        ok: false,
        errorCode: 'unexpected',
        errorMessage: (err as Error).message,
      };
    }
  }
}
