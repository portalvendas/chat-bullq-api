import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';
import type {
  ActionPreview,
  PendingAction,
  PendingActionStatus,
} from './confirmation.types';

/**
 * Prisma-backed storage for `PendingAction` records (Fase 2).
 *
 * Substitui o storage Redis interim. Mantém a mesma interface pública
 * (save/get/listByStatus/listByConversation) — service e controller
 * continuam funcionando sem mudança.
 */
@Injectable()
export class PendingActionStorage {
  private readonly logger = new Logger(PendingActionStorage.name);

  constructor(private readonly prisma: PrismaService) {}

  async save(
    action: PendingAction,
    _previousStatus?: PendingActionStatus,
  ): Promise<void> {
    await this.prisma.aiPendingAction.upsert({
      where: { id: action.id },
      create: {
        id: action.id,
        agentRunId: action.agentRunId,
        conversationId: action.conversationId,
        agentId: action.agentId,
        toolName: action.toolName,
        args: action.args as Prisma.InputJsonValue,
        preview: action.preview as unknown as Prisma.InputJsonValue,
        status: action.status,
        expiresAt: new Date(action.expiresAt),
        approvedBy: action.approvedBy ?? null,
        approvedAt: action.approvedAt ? new Date(action.approvedAt) : null,
        rejectedBy: action.rejectedBy ?? null,
        rejectedAt: action.rejectedAt ? new Date(action.rejectedAt) : null,
        rejectedReason: action.rejectedReason ?? null,
        executionResult:
          (action.executionResult as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
      update: {
        status: action.status,
        approvedBy: action.approvedBy ?? null,
        approvedAt: action.approvedAt ? new Date(action.approvedAt) : null,
        rejectedBy: action.rejectedBy ?? null,
        rejectedAt: action.rejectedAt ? new Date(action.rejectedAt) : null,
        rejectedReason: action.rejectedReason ?? null,
        executionResult:
          (action.executionResult as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
    });
  }

  async get(id: string): Promise<PendingAction | null> {
    const row = await this.prisma.aiPendingAction.findUnique({ where: { id } });
    return row ? this.toDomain(row) : null;
  }

  async listByStatus(
    status: PendingActionStatus,
    conversationId?: string,
  ): Promise<PendingAction[]> {
    const rows = await this.prisma.aiPendingAction.findMany({
      where: {
        status,
        ...(conversationId ? { conversationId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDomain(r));
  }

  async listByConversation(conversationId: string): Promise<PendingAction[]> {
    const rows = await this.prisma.aiPendingAction.findMany({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
    });
    return rows.map((r) => this.toDomain(r));
  }

  private toDomain(row: {
    id: string;
    agentRunId: string;
    conversationId: string;
    agentId: string;
    toolName: string;
    args: Prisma.JsonValue;
    preview: Prisma.JsonValue;
    status: PendingActionStatus;
    expiresAt: Date;
    approvedBy: string | null;
    approvedAt: Date | null;
    rejectedBy: string | null;
    rejectedAt: Date | null;
    rejectedReason: string | null;
    executionResult: Prisma.JsonValue | null;
    createdAt: Date;
  }): PendingAction {
    return {
      id: row.id,
      agentRunId: row.agentRunId,
      conversationId: row.conversationId,
      agentId: row.agentId,
      toolName: row.toolName,
      args: (row.args ?? {}) as Record<string, unknown>,
      preview: row.preview as unknown as ActionPreview,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
      expiresAt: row.expiresAt.toISOString(),
      approvedBy: row.approvedBy ?? undefined,
      approvedAt: row.approvedAt?.toISOString(),
      rejectedBy: row.rejectedBy ?? undefined,
      rejectedAt: row.rejectedAt?.toISOString(),
      rejectedReason: row.rejectedReason ?? undefined,
      executionResult: row.executionResult ?? undefined,
    };
  }
}
