import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Automation, AutomationTrigger, Prisma } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AutomationsValidator } from './automations.validator';
import { ConditionsEvaluator } from './engine/conditions-evaluator';
import { CreateAutomationDto, UpdateAutomationDto } from './dto/automation.dto';
import { ActionRegistryService } from './actions/action-registry.service';
import { ACTION_TYPES } from './actions/action.types';
import { FIELDS_BY_TRIGGER } from './engine/conditions-evaluator';
import { AutomationEventPayload } from './automations.types';

const MAX_AUTOMATIONS_PER_ORG = 100;

@Injectable()
export class AutomationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly validator: AutomationsValidator,
    private readonly evaluator: ConditionsEvaluator,
    private readonly registry: ActionRegistryService,
  ) {}

  // ─── CRUD ────────────────────────────────────────────────────────

  async list(organizationId: string) {
    return this.prisma.automation.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
    });
  }

  async findOne(id: string, organizationId: string): Promise<Automation> {
    const automation = await this.prisma.automation.findFirst({
      where: { id, organizationId, deletedAt: null },
    });
    if (!automation) {
      throw new NotFoundException('Automation not found');
    }
    return automation;
  }

  async create(
    organizationId: string,
    actorId: string,
    dto: CreateAutomationDto,
  ) {
    const count = await this.prisma.automation.count({
      where: { organizationId, deletedAt: null },
    });
    if (count >= MAX_AUTOMATIONS_PER_ORG) {
      throw new ForbiddenException(
        `Workspace has reached the limit of ${MAX_AUTOMATIONS_PER_ORG} automations`,
      );
    }
    const conditions = this.validator.validateConditions(
      dto.trigger,
      dto.conditions,
    );
    const actions = this.validator.validateActions(dto.actions);

    return this.prisma.automation.create({
      data: {
        organizationId,
        name: dto.name,
        description: dto.description ?? null,
        trigger: dto.trigger,
        conditions: conditions as unknown as Prisma.InputJsonValue,
        actions: actions as unknown as Prisma.InputJsonValue,
        enabled: dto.enabled ?? false,
        actorId,
        priority: dto.priority ?? 0,
        rateLimitPerMinute: dto.rateLimitPerMinute ?? 10,
      },
    });
  }

  async update(
    id: string,
    organizationId: string,
    dto: UpdateAutomationDto,
  ) {
    const existing = await this.findOne(id, organizationId);

    // Trigger change requires re-validating conditions against the new
    // field set. We push everything through the validator pipeline.
    const trigger = dto.trigger ?? existing.trigger;
    const data: Prisma.AutomationUpdateInput = {};

    if (dto.name !== undefined) data.name = dto.name;
    if (dto.description !== undefined) data.description = dto.description;
    if (dto.priority !== undefined) data.priority = dto.priority;
    if (dto.rateLimitPerMinute !== undefined) {
      data.rateLimitPerMinute = dto.rateLimitPerMinute;
    }
    if (dto.trigger !== undefined) data.trigger = dto.trigger;

    if (dto.conditions !== undefined || dto.trigger !== undefined) {
      const condRaw = dto.conditions ?? existing.conditions;
      const conditions = this.validator.validateConditions(trigger, condRaw);
      data.conditions = conditions as unknown as Prisma.InputJsonValue;
    }

    if (dto.actions !== undefined) {
      const actions = this.validator.validateActions(dto.actions);
      data.actions = actions as unknown as Prisma.InputJsonValue;
    }

    if (dto.enabled !== undefined) {
      data.enabled = dto.enabled;
      // Re-enabling clears auto-pause state (user acknowledged the issue
      // and is opting back in). Without this, an auto-paused regra stays
      // paused even after being toggled on.
      if (dto.enabled) {
        data.consecutiveFailures = 0;
        data.autoPausedAt = null;
        data.autoPausedReason = null;
      }
    }

    return this.prisma.automation.update({
      where: { id },
      data,
    });
  }

  async remove(id: string, organizationId: string) {
    await this.findOne(id, organizationId);
    return this.prisma.automation.update({
      where: { id },
      data: { deletedAt: new Date(), enabled: false },
    });
  }

  async toggle(id: string, organizationId: string, enabled: boolean) {
    return this.update(id, organizationId, { enabled });
  }

  // ─── Meta — UI form scaffolding ──────────────────────────────────

  getMeta() {
    const triggers = Object.values(AutomationTrigger).map((t) => ({
      value: t,
      fields: Object.keys(FIELDS_BY_TRIGGER[t] ?? {}),
    }));
    const actions = this.registry.all().map((h) => ({
      type: h.type,
      continueOnErrorDefault: h.continueOnErrorDefault,
    }));
    return {
      triggers,
      actions: ACTION_TYPES.map((type) => ({
        type,
        ...(actions.find((a) => a.type === type) ?? {}),
      })),
      operators: [
        'equals',
        'not_equals',
        'contains',
        'not_contains',
        'in',
        'not_in',
        'is_set',
        'is_not_set',
      ],
    };
  }

  // ─── Dry run — evaluate against a mock payload, NO execution ─────

  async dryRun(
    id: string,
    organizationId: string,
    payload: Record<string, unknown>,
  ) {
    const automation = await this.findOne(id, organizationId);
    const matched = this.evaluator.evaluate(
      automation.trigger,
      automation.conditions as unknown,
      payload as unknown as AutomationEventPayload,
    );
    return {
      matched,
      conditions: automation.conditions,
      actions: automation.actions,
      // We deliberately do NOT execute actions here — dry-run is a
      // condition check only. Adding "would do X" simulation would
      // require running each handler in a no-side-effect mode, which is
      // a bigger feature than what users actually need to validate
      // their condition logic.
    };
  }
}
