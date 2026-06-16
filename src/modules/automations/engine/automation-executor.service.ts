import { Injectable, Logger } from '@nestjs/common';
import {
  Automation,
  AutomationRunStatus,
  AutomationTrigger,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ConditionsEvaluator } from './conditions-evaluator';
import { ActionRegistryService } from '../actions/action-registry.service';
import {
  ActionContext,
  ActionDefinition,
  ActionLogEntry,
  isActionType,
} from '../actions/action.types';
import { OutboxService } from '../outbox/outbox.service';
import { AutomationRedisService } from '../redis/automation-redis.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import {
  AUTO_DISABLE_AFTER_FAILURES,
  CURRENT_AUTOMATION_SCHEMA_VERSION,
  MAX_CASCADE_DEPTH,
} from '../automations.constants';
import { AutomationJobData } from '../automations.types';

@Injectable()
export class AutomationExecutorService {
  private readonly logger = new Logger(AutomationExecutorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly evaluator: ConditionsEvaluator,
    private readonly registry: ActionRegistryService,
    private readonly outbox: OutboxService,
    private readonly redis: AutomationRedisService,
    private readonly realtime: RealtimeGateway,
  ) {}

  // Main entry point. The processor calls this for every job. We never
  // throw from here — all error paths persist a SKIPPED/FAILED run row
  // so the UI can surface what happened. Throwing would make BullMQ
  // retry, which on a permanently-broken rule would loop forever.
  async execute(job: AutomationJobData): Promise<void> {
    const { organizationId, trigger, traceId, cascadeDepth } = job;

    if (cascadeDepth >= MAX_CASCADE_DEPTH) {
      // No automations to run — log nothing. We're at the cap to prevent
      // infinite cascades, and there's no specific rule to attribute
      // this to. The original event's run log will show the chain depth.
      this.logger.warn(
        `cascade depth ${cascadeDepth} >= ${MAX_CASCADE_DEPTH} — dropping ${trigger}`,
      );
      return;
    }

    const automations = await this.findMatchingAutomations(
      organizationId,
      trigger,
    );
    if (automations.length === 0) return;

    for (const automation of automations) {
      // Loop guard: same automation can't appear twice in the same trace.
      // Bigger picture: a chain like A → B → A would be a depth-2 loop;
      // depth limit alone catches it but visited check rejects it sooner
      // and with a clearer reason.
      if (job.visitedAutomations.includes(automation.id)) {
        await this.persistRun(automation, job, {
          status: AutomationRunStatus.SKIPPED,
          errorCode: 'loop_detected',
          errorMessage: 'automation already ran earlier in this trace',
          actionsLog: [],
          durationMs: 0,
        });
        continue;
      }

      // Schema version mismatch = refuse to run. Better than silently
      // executing with potentially-incompatible JSON.
      if (automation.schemaVersion !== CURRENT_AUTOMATION_SCHEMA_VERSION) {
        await this.persistRun(automation, job, {
          status: AutomationRunStatus.SKIPPED,
          errorCode: 'schema_version_mismatch',
          errorMessage: `regra v${automation.schemaVersion}, runtime v${CURRENT_AUTOMATION_SCHEMA_VERSION}`,
          actionsLog: [],
          durationMs: 0,
        });
        continue;
      }

      // Conditions check before lock acquisition — no point holding a
      // lock for a rule that's not going to fire anyway.
      const matched = this.evaluator.evaluate(
        trigger,
        automation.conditions as unknown,
        job.payload,
      );
      if (!matched) {
        // SKIPPED runs for "didn't match" pollute the log. We deliberately
        // DO NOT persist these — the UI shows runs as "things that fired
        // and either succeeded or failed". A counter for "evaluated but
        // didn't match" is something to add later if we ever need it.
        continue;
      }

      // Validate the actor is still authorized. If they were removed
      // from the org, auto-pause the automation and skip.
      const actorOk = await this.checkActor(
        automation.actorId,
        automation.organizationId,
      );
      if (!actorOk) {
        await this.persistRun(automation, job, {
          status: AutomationRunStatus.SKIPPED,
          errorCode: 'actor_unauthorized',
          errorMessage: 'creator no longer in workspace',
          actionsLog: [],
          durationMs: 0,
        });
        await this.autoPause(
          automation.id,
          'creator no longer in workspace',
        );
        continue;
      }

      // Rate limit check (per automation × conversation, sliding 60s)
      const rateOk = await this.redis.tryConsumeRateLimit(
        automation.id,
        job.payload.conversationId,
        automation.rateLimitPerMinute,
      );
      if (!rateOk) {
        await this.persistRun(automation, job, {
          status: AutomationRunStatus.SKIPPED,
          errorCode: 'rate_limited',
          errorMessage: `>${automation.rateLimitPerMinute}/min on this conversation`,
          actionsLog: [],
          durationMs: 0,
        });
        continue;
      }

      // Acquire the per-contact lock so two concurrent events for the
      // same contact don't fight over state.
      const lockToken = await this.redis.acquireContactLock(
        job.payload.contactId,
      );
      if (!lockToken) {
        // Couldn't get the lock — another worker has it. Re-throw so
        // BullMQ retries this job (with backoff). This is one of the
        // few places we DO want a throw — transient contention.
        throw new Error(
          `contact ${job.payload.contactId} locked — will retry`,
        );
      }

      try {
        await this.runActions(automation, job);
      } finally {
        await this.redis.releaseContactLock(
          job.payload.contactId,
          lockToken,
        );
      }
    }
  }

  // The hot path: iterate actions, run each, log, decide whether to
  // continue on error.
  private async runActions(
    automation: Automation,
    job: AutomationJobData,
  ): Promise<void> {
    const startedAt = Date.now();
    const actions = this.parseActions(automation.actions);
    const log: ActionLogEntry[] = [];
    let anyFailure = false;
    let aborted = false;

    const ctx: ActionContext = {
      organizationId: automation.organizationId,
      payload: job.payload,
      traceId: job.traceId,
      cascadeDepth: job.cascadeDepth + 1, // emitted events live one hop deeper
      visitedAutomations: [...job.visitedAutomations, automation.id],
      outbox: this.outbox,
      // Re-cast: PrismaService extends PrismaClient so the cast is safe.
      prisma: this.prisma as unknown as ActionContext['prisma'],
      actorId: automation.actorId,
    };

    for (let i = 0; i < actions.length; i++) {
      const action = actions[i];
      const handler = this.registry.get(action.type as never);
      if (!handler) {
        log.push({
          index: i,
          type: action.type,
          status: 'failed',
          durationMs: 0,
          errorCode: 'unknown_action',
          errorMessage: `no handler for ${action.type}`,
        });
        anyFailure = true;
        if (!(action.continueOnError ?? false)) {
          aborted = true;
          break;
        }
        continue;
      }

      const startedAction = Date.now();
      try {
        const result = await handler.execute(action.params, ctx);
        const dur = Date.now() - startedAction;
        if (result.ok) {
          log.push({
            index: i,
            type: action.type,
            status: 'success',
            durationMs: dur,
            output: result.output,
          });
        } else {
          anyFailure = true;
          log.push({
            index: i,
            type: action.type,
            status: 'failed',
            durationMs: dur,
            errorCode: result.errorCode,
            errorMessage: result.errorMessage,
            output: result.output,
          });
          const continueOnError =
            action.continueOnError ?? handler.continueOnErrorDefault;
          if (!continueOnError) {
            aborted = true;
            break;
          }
        }
      } catch (err) {
        // Handler threw. Treat as failure with the same continue-on-error
        // policy — handlers shouldn't throw, but defending here means a
        // bug in one handler doesn't poison the whole run.
        const dur = Date.now() - startedAction;
        anyFailure = true;
        log.push({
          index: i,
          type: action.type,
          status: 'failed',
          durationMs: dur,
          errorCode: 'handler_threw',
          errorMessage: (err as Error).message,
        });
        const continueOnError =
          action.continueOnError ?? handler.continueOnErrorDefault;
        if (!continueOnError) {
          aborted = true;
          break;
        }
      }
    }

    const durationMs = Date.now() - startedAt;

    let runStatus: AutomationRunStatus;
    if (!anyFailure) runStatus = AutomationRunStatus.SUCCESS;
    else if (aborted) runStatus = AutomationRunStatus.FAILED;
    else runStatus = AutomationRunStatus.PARTIAL;

    await this.persistRun(automation, job, {
      status: runStatus,
      actionsLog: log,
      durationMs,
    });

    await this.updateAutomationCounters(automation.id, runStatus);
  }

  // ─── Persistence helpers ──────────────────────────────────────────

  private async persistRun(
    automation: Automation,
    job: AutomationJobData,
    data: {
      status: AutomationRunStatus;
      errorCode?: string;
      errorMessage?: string;
      actionsLog: ActionLogEntry[];
      durationMs: number;
    },
  ) {
    try {
      const run = await this.prisma.automationRun.create({
        data: {
          automationId: automation.id,
          organizationId: automation.organizationId,
          outboxEventId: job.outboxEventId,
          traceId: job.traceId,
          status: data.status,
          errorCode: data.errorCode ?? null,
          errorMessage: data.errorMessage ?? null,
          triggerPayload: job.payload as unknown as Prisma.InputJsonValue,
          actionsLog: data.actionsLog as unknown as Prisma.InputJsonValue,
          durationMs: data.durationMs,
          finishedAt: new Date(),
        },
      });
      // Broadcast to everyone in the org so any open Activity panel
      // updates without polling. Payload carries the full row so the
      // client can drop it straight into the list — no need to refetch.
      this.realtime.emitToOrg(automation.organizationId, 'automation:run', {
        automationId: automation.id,
        run,
      });
    } catch (err) {
      this.logger.error(
        `Failed to persist run for automation ${automation.id}: ${(err as Error).message}`,
      );
    }
  }

  private async updateAutomationCounters(
    automationId: string,
    status: AutomationRunStatus,
  ) {
    if (status === AutomationRunStatus.SUCCESS) {
      await this.prisma.automation.update({
        where: { id: automationId },
        data: {
          runCount: { increment: 1 },
          successCount: { increment: 1 },
          consecutiveFailures: 0,
          lastRunAt: new Date(),
        },
      });
      return;
    }

    if (
      status === AutomationRunStatus.FAILED ||
      status === AutomationRunStatus.PARTIAL
    ) {
      const updated = await this.prisma.automation.update({
        where: { id: automationId },
        data: {
          runCount: { increment: 1 },
          failureCount: { increment: 1 },
          consecutiveFailures: { increment: 1 },
          lastRunAt: new Date(),
        },
        select: { consecutiveFailures: true },
      });
      if (updated.consecutiveFailures >= AUTO_DISABLE_AFTER_FAILURES) {
        await this.autoPause(
          automationId,
          `${updated.consecutiveFailures} consecutive failures`,
        );
      }
      return;
    }

    // SKIPPED — count it but don't trip the failure ladder.
    await this.prisma.automation.update({
      where: { id: automationId },
      data: { runCount: { increment: 1 }, lastRunAt: new Date() },
    });
  }

  private async autoPause(automationId: string, reason: string) {
    await this.prisma.automation.update({
      where: { id: automationId },
      data: {
        enabled: false,
        autoPausedAt: new Date(),
        autoPausedReason: reason,
      },
    });
    this.logger.error(
      `Auto-paused automation ${automationId}: ${reason}`,
    );
  }

  // ─── Lookups ──────────────────────────────────────────────────────

  private async findMatchingAutomations(
    organizationId: string,
    trigger: AutomationTrigger,
  ): Promise<Automation[]> {
    return this.prisma.automation.findMany({
      where: {
        organizationId,
        trigger,
        enabled: true,
        deletedAt: null,
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
    });
  }

  private async checkActor(
    actorId: string,
    organizationId: string,
  ): Promise<boolean> {
    const member = await this.prisma.userOrganization.findFirst({
      where: { userId: actorId, organizationId },
      select: { id: true },
    });
    return !!member;
  }

  private parseActions(raw: unknown): ActionDefinition[] {
    if (!Array.isArray(raw)) return [];
    const out: ActionDefinition[] = [];
    for (const a of raw) {
      if (!a || typeof a !== 'object') continue;
      const action = a as ActionDefinition;
      if (!isActionType(action.type)) continue;
      out.push({
        type: action.type,
        params:
          action.params && typeof action.params === 'object'
            ? action.params
            : {},
        continueOnError: action.continueOnError,
      });
    }
    return out;
  }
}
