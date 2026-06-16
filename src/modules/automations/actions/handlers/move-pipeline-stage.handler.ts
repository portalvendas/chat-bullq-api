import { Injectable } from '@nestjs/common';
import {
  ActionContext,
  ActionExecutionResult,
  ActionHandler,
} from '../action.types';

interface MovePipelineStageParams {
  // Either the rule targets a specific pipeline (move within it) or
  // omits it (move within whatever pipeline the lead's open card lives in).
  pipelineId?: string;
  toStageId: string;
}

@Injectable()
export class MovePipelineStageHandler implements ActionHandler {
  readonly type = 'move_pipeline_stage' as const;
  readonly continueOnErrorDefault = false;

  validateParams(params: Record<string, unknown>): void {
    if (!params.toStageId || typeof params.toStageId !== 'string') {
      throw new Error('move_pipeline_stage: "toStageId" is required (string)');
    }
    if (
      params.pipelineId !== undefined &&
      typeof params.pipelineId !== 'string'
    ) {
      throw new Error('move_pipeline_stage: "pipelineId" must be string when provided');
    }
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ActionContext,
  ): Promise<ActionExecutionResult> {
    const p = params as unknown as MovePipelineStageParams;
    const { organizationId, payload, prisma } = ctx;

    const stage = await prisma.pipelineStage.findFirst({
      where: { id: p.toStageId },
      include: { pipeline: true },
    });
    if (!stage || stage.pipeline.organizationId !== organizationId) {
      return {
        ok: false,
        errorCode: 'invalid_ref',
        errorMessage: `stage ${p.toStageId} not found in org`,
      };
    }
    if (p.pipelineId && stage.pipelineId !== p.pipelineId) {
      return {
        ok: false,
        errorCode: 'invalid_params',
        errorMessage: 'toStageId does not belong to pipelineId',
      };
    }

    // Find the open card to move. We constrain to the same pipeline as
    // the target stage — moving across pipelines is a different mental
    // model and probably wants its own action.
    const card = await prisma.card.findFirst({
      where: {
        organizationId,
        pipelineId: stage.pipelineId,
        contactId: payload.contactId,
        status: 'OPEN',
      },
      orderBy: { updatedAt: 'desc' },
    });
    if (!card) {
      return {
        ok: false,
        errorCode: 'no_card',
        errorMessage: 'no open card for this contact in target pipeline',
      };
    }

    if (card.stageId === stage.id) {
      return { ok: true, output: { cardId: card.id, alreadyOnStage: true } };
    }

    // If the destination is a closing stage (WON/LOST), set status too.
    const updates: Record<string, unknown> = { stageId: stage.id };
    if (stage.type === 'WON') {
      updates.status = 'WON';
      updates.closedAt = new Date();
    } else if (stage.type === 'LOST') {
      updates.status = 'LOST';
      updates.closedAt = new Date();
    } else if (card.status !== 'OPEN') {
      // Re-opening a closed card if user set up the rule that way.
      updates.status = 'OPEN';
      updates.closedAt = null;
    }

    try {
      const updated = await prisma.card.update({
        where: { id: card.id },
        data: updates,
      });
      return {
        ok: true,
        output: {
          cardId: updated.id,
          fromStageId: card.stageId,
          toStageId: stage.id,
        },
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
