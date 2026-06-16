import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  MessageContentType,
  MessageDirection,
  MessageStatus,
} from '@prisma/client';
import {
  ActionContext,
  ActionExecutionResult,
  ActionHandler,
} from '../action.types';

interface SendMessageParams {
  // Plain text only in PR2. Templates with vars come later if there's
  // demand — every template feature ships its own footgun.
  body: string;
}

@Injectable()
export class SendMessageHandler implements ActionHandler {
  private readonly logger = new Logger(SendMessageHandler.name);

  readonly type = 'send_message' as const;
  // Communication failures (Uazapi 5xx, IG quota, etc.) shouldn't block
  // state-changing actions that come after. Default to continueOnError.
  readonly continueOnErrorDefault = true;

  // Simple in-process circuit breaker per channel. Three failures within
  // the rolling window opens the breaker for COOLDOWN_MS — during the
  // cooldown, send_message returns short-circuit failures so we don't
  // hammer a known-broken provider. Per-process state, no Redis sync
  // (good enough — even one hot replica protects).
  private readonly failures = new Map<string, number[]>();
  private static readonly FAIL_WINDOW_MS = 60_000;
  private static readonly FAIL_THRESHOLD = 3;
  private static readonly COOLDOWN_MS = 30_000;
  private readonly openUntil = new Map<string, number>();

  constructor(
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  validateParams(params: Record<string, unknown>): void {
    if (!params.body || typeof params.body !== 'string') {
      throw new Error('send_message: "body" is required (string)');
    }
    if ((params.body as string).trim().length === 0) {
      throw new Error('send_message: "body" cannot be empty');
    }
    if ((params.body as string).length > 4096) {
      throw new Error('send_message: "body" too long (max 4096 chars)');
    }
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ActionContext,
  ): Promise<ActionExecutionResult> {
    const p = params as unknown as SendMessageParams;
    const { organizationId, payload, prisma } = ctx;

    if (!payload.conversationId) {
      return {
        ok: false,
        errorCode: 'no_active_channel',
        errorMessage: 'send_message requires an active conversation',
      };
    }

    const conversation = await prisma.conversation.findFirst({
      where: { id: payload.conversationId, organizationId },
      include: { contact: { include: { channels: true } } },
    });
    if (!conversation) {
      return {
        ok: false,
        errorCode: 'invalid_ref',
        errorMessage: 'conversation not found',
      };
    }

    const contactChannel = conversation.contact.channels.find(
      (cc) => cc.channelId === conversation.channelId,
    );
    if (!contactChannel) {
      return {
        ok: false,
        errorCode: 'no_active_channel',
        errorMessage: 'contact has no binding for the conversation channel',
      };
    }

    // Circuit breaker check — same channel just blew up multiple times,
    // skip with a clear code so the run log explains the silence.
    const breakerKey = conversation.channelId;
    const openUntil = this.openUntil.get(breakerKey) ?? 0;
    if (Date.now() < openUntil) {
      return {
        ok: false,
        errorCode: 'circuit_open',
        errorMessage: `channel ${breakerKey} is in cooldown — provider failing`,
      };
    }

    try {
      const message = await prisma.message.create({
        data: {
          conversationId: conversation.id,
          direction: MessageDirection.OUTBOUND,
          type: MessageContentType.TEXT,
          content: { text: p.body },
          status: MessageStatus.QUEUED,
          // senderId null = system-sent. UI shows it as "Automação".
          senderId: null,
          metadata: {
            source: 'automation',
            actorId: ctx.actorId,
            traceId: ctx.traceId,
          },
        },
      });
      await this.outboundQueue.add(
        'send-outbound',
        {
          messageId: message.id,
          channelId: conversation.channelId,
          contactExternalId: contactChannel.externalId,
          message: { type: 'TEXT', content: { text: p.body } },
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 2000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );
      // Successful enqueue resets the failure counter. The actual delivery
      // failure (provider 5xx) won't be visible here — that's tracked by
      // the outbound queue's own dead-letter handling.
      this.failures.delete(breakerKey);
      return {
        ok: true,
        output: { messageId: message.id, channelId: conversation.channelId },
      };
    } catch (err) {
      this.recordFailure(breakerKey);
      this.logger.warn(
        `send_message failed for conv ${conversation.id}: ${(err as Error).message}`,
      );
      return {
        ok: false,
        errorCode: 'external_error',
        errorMessage: (err as Error).message,
      };
    }
  }

  private recordFailure(key: string) {
    const now = Date.now();
    const recent = (this.failures.get(key) ?? []).filter(
      (t) => now - t < SendMessageHandler.FAIL_WINDOW_MS,
    );
    recent.push(now);
    this.failures.set(key, recent);
    if (recent.length >= SendMessageHandler.FAIL_THRESHOLD) {
      this.openUntil.set(key, now + SendMessageHandler.COOLDOWN_MS);
      this.failures.delete(key);
      this.logger.error(
        `Circuit breaker OPEN for channel ${key} — cooldown ${SendMessageHandler.COOLDOWN_MS}ms`,
      );
    }
  }
}
