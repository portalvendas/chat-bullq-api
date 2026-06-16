import { BadRequestException, Injectable } from '@nestjs/common';
import { AutomationTrigger } from '@prisma/client';
import { ActionRegistryService } from './actions/action-registry.service';
import {
  ActionDefinition,
  isActionType,
} from './actions/action.types';
import {
  ConditionGroup,
  ConditionRoot,
  FIELDS_BY_TRIGGER,
} from './engine/conditions-evaluator';

const VALID_OPERATORS = new Set([
  'equals',
  'not_equals',
  'contains',
  'not_contains',
  'in',
  'not_in',
  'is_set',
  'is_not_set',
]);

// Centralized save-time validator. Both create and update flows MUST go
// through here — validation lives apart from the controller so the same
// rules apply to dry-run, manual-trigger, and any future seeding paths.
@Injectable()
export class AutomationsValidator {
  constructor(private readonly registry: ActionRegistryService) {}

  validateConditions(
    trigger: AutomationTrigger,
    raw: unknown,
  ): ConditionRoot | Record<string, never> {
    if (raw == null) return {};
    if (typeof raw !== 'object') {
      throw new BadRequestException('conditions must be an object');
    }
    const c = raw as ConditionRoot;
    // "no conditions" passes as an empty object — semantic match-everything.
    if (!('match' in c) && !('groups' in c)) return {};
    if (c.match !== 'AND' && c.match !== 'OR') {
      throw new BadRequestException('conditions.match must be AND | OR');
    }
    if (!Array.isArray(c.groups)) {
      throw new BadRequestException('conditions.groups must be an array');
    }
    const fields = FIELDS_BY_TRIGGER[trigger];
    if (!fields) {
      throw new BadRequestException(`unknown trigger: ${trigger}`);
    }
    c.groups.forEach((g, gi) => this.validateGroup(g, gi, fields));
    return c;
  }

  validateActions(raw: unknown): ActionDefinition[] {
    if (!Array.isArray(raw)) {
      throw new BadRequestException('actions must be an array');
    }
    if (raw.length === 0) {
      throw new BadRequestException('automation must have at least one action');
    }
    if (raw.length > 20) {
      throw new BadRequestException('too many actions (max 20)');
    }
    return raw.map((a, i) => this.validateAction(a, i));
  }

  private validateGroup(
    group: unknown,
    index: number,
    fields: Record<string, unknown>,
  ): void {
    const g = group as ConditionGroup;
    if (!g || typeof g !== 'object') {
      throw new BadRequestException(`groups[${index}] must be an object`);
    }
    if (g.match !== 'AND' && g.match !== 'OR') {
      throw new BadRequestException(`groups[${index}].match must be AND | OR`);
    }
    if (!Array.isArray(g.rules)) {
      throw new BadRequestException(`groups[${index}].rules must be an array`);
    }
    if (g.rules.length === 0) {
      throw new BadRequestException(`groups[${index}].rules cannot be empty`);
    }
    g.rules.forEach((rule, ri) => {
      if (!rule || typeof rule !== 'object') {
        throw new BadRequestException(
          `groups[${index}].rules[${ri}] must be an object`,
        );
      }
      const r = rule as { field: string; op: string; value?: unknown };
      if (typeof r.field !== 'string' || !(r.field in fields)) {
        throw new BadRequestException(
          `groups[${index}].rules[${ri}]: unknown field "${r.field}"`,
        );
      }
      if (typeof r.op !== 'string' || !VALID_OPERATORS.has(r.op)) {
        throw new BadRequestException(
          `groups[${index}].rules[${ri}]: unknown op "${r.op}"`,
        );
      }
      if (r.op === 'is_set' || r.op === 'is_not_set') {
        return; // value not required
      }
      if (r.value === undefined) {
        throw new BadRequestException(
          `groups[${index}].rules[${ri}]: value required for op "${r.op}"`,
        );
      }
      if (
        (r.op === 'in' || r.op === 'not_in') &&
        !Array.isArray(r.value)
      ) {
        throw new BadRequestException(
          `groups[${index}].rules[${ri}]: op "${r.op}" requires array value`,
        );
      }
    });
  }

  private validateAction(raw: unknown, index: number): ActionDefinition {
    if (!raw || typeof raw !== 'object') {
      throw new BadRequestException(`actions[${index}] must be an object`);
    }
    const a = raw as ActionDefinition;
    if (!isActionType(a.type)) {
      throw new BadRequestException(
        `actions[${index}].type "${a.type}" not supported`,
      );
    }
    const handler = this.registry.get(a.type);
    if (!handler) {
      throw new BadRequestException(
        `actions[${index}]: no handler registered for type ${a.type}`,
      );
    }
    const params =
      a.params && typeof a.params === 'object' ? a.params : {};
    try {
      handler.validateParams(params);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
    return {
      type: a.type,
      params,
      continueOnError:
        typeof a.continueOnError === 'boolean'
          ? a.continueOnError
          : handler.continueOnErrorDefault,
    };
  }
}
