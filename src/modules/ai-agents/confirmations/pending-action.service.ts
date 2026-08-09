import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import type {
  CreatePendingActionInput,
  PendingAction,
  PendingActionStatus,
} from './confirmation.types';
import { PendingActionStorage } from './pending-action.storage';
import { PENDING_ACTION_EXECUTOR_QUEUE } from './queue-names';
import { PrismaService } from '../../../database/prisma.service';
import { MessageDirection } from '@prisma/client';

/**
 * Service that owns the lifecycle of `PendingAction` records.
 *
 * Phase 1: pure CRUD + approve/reject + expiration check.
 * Phase 2: on `approve()` enqueue the actual tool execution (the args
 * are stored verbatim on the record).
 */
@Injectable()
export class PendingActionService {
  private readonly logger = new Logger(PendingActionService.name);
  private readonly DEFAULT_TTL_MIN = 30;

  /**
   * Sentinela de "nunca expira" — a coluna expires_at é NOT NULL, então em vez
   * de tornar o campo nullable (migration), usamos uma data absurdamente
   * distante. `isExpired` compara com Date.now(), então far-future = nunca
   * expira. Usado nas respostas ao cliente em modo revisão (replyToConversation):
   * a resposta NÃO pode sumir da fila em silêncio — se sumisse, o cliente
   * ficaria sem resposta pra sempre. Só sai da fila por aprovar/rejeitar ou por
   * ser SUPERADA por uma resposta mais nova da mesma conversa (dedup).
   */
  private readonly NEVER_EXPIRES_ISO = '9999-12-31T23:59:59.000Z';

  /** Tools cuja resposta é ao cliente e não deve expirar por tempo. */
  private readonly NON_EXPIRING_TOOLS = new Set(['replyToConversation']);

  constructor(
    private readonly storage: PendingActionStorage,
    private readonly prisma: PrismaService,
    @InjectQueue(PENDING_ACTION_EXECUTOR_QUEUE)
    private readonly executorQueue: Queue,
  ) {}

  /** Create a new PENDING action for human review. */
  async create(input: CreatePendingActionInput): Promise<PendingAction> {
    // DEDUP de resposta ao cliente: um run duplicado (ex: watchdog re-engajou)
    // geraria um 2º card contraditório pra mesma conversa. Antes de criar uma
    // nova `replyToConversation`, expira as respostas PENDENTES anteriores da
    // MESMA conversa — só a mais recente fica na tela.
    if (input.toolName === 'replyToConversation') {
      try {
        const prior = await this.storage.listByStatus(
          'PENDING',
          input.conversationId,
        );
        for (const p of prior) {
          if (p.toolName === 'replyToConversation') {
            p.status = 'EXPIRED';
            await this.storage.save(p, 'PENDING');
          }
        }
      } catch (err: any) {
        this.logger.warn(
          `dedupe de pending reply falhou (conv=${input.conversationId}): ${err?.message ?? err}`,
        );
      }
    }

    const now = new Date();
    // Respostas ao cliente (replyToConversation) NUNCA expiram por tempo —
    // ficam na fila até aprovar/rejeitar (ou serem superadas por uma resposta
    // mais nova via dedup acima). Demais ações (confirmação de tools
    // destrutivas) mantêm o TTL padrão de 30 min.
    const noExpiry = this.NON_EXPIRING_TOOLS.has(input.toolName);
    const ttlMin = input.ttlMinutes ?? this.DEFAULT_TTL_MIN;
    const expiresAtIso = noExpiry
      ? this.NEVER_EXPIRES_ISO
      : new Date(now.getTime() + ttlMin * 60 * 1000).toISOString();

    const action: PendingAction = {
      id: randomUUID(),
      agentRunId: input.agentRunId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      toolName: input.toolName,
      args: input.args,
      preview: input.preview,
      status: 'PENDING',
      createdAt: now.toISOString(),
      expiresAt: expiresAtIso,
    };

    await this.storage.save(action);

    this.logger.log({
      msg: 'pending_action_created',
      id: action.id,
      toolName: action.toolName,
      impact: action.preview.impact,
      conversationId: action.conversationId,
      expiresAt: action.expiresAt,
    });

    return action;
  }

  /**
   * Approve a pending action. If it has already expired in storage,
   * the status is moved to EXPIRED and the call fails.
   *
   * Phase 2 TODO: enqueue the actual execution of `action.toolName`
   * with `action.args` and persist `executionResult` once it runs.
   */
  async approve(
    id: string,
    userId: string,
    editedText?: string,
  ): Promise<PendingAction> {
    const action = await this.storage.get(id);
    if (!action) throw new NotFoundException('Pending action not found');

    if (action.status !== 'PENDING') {
      throw new BadRequestException(
        `Action is ${action.status} and cannot be approved`,
      );
    }

    if (this.isExpired(action)) {
      const previous = action.status;
      action.status = 'EXPIRED';
      await this.storage.save(action, previous);
      throw new BadRequestException('Action expired');
    }

    // Edição humana antes de aprovar (só resposta ao cliente). Guarda o
    // texto ORIGINAL da IA em `originalText` — o par (original → editado)
    // é sinal de aprendizado. O executor envia `args.text` (já editado).
    if (
      editedText != null &&
      action.toolName === 'replyToConversation'
    ) {
      const trimmed = editedText.trim();
      const current = String((action.args as any)?.text ?? '');
      if (trimmed && trimmed !== current) {
        action.args = {
          ...action.args,
          text: trimmed,
          originalText: current,
          editedByHuman: true,
        };
        (action.preview as any).action = trimmed;
      }
    }

    const previous = action.status;
    action.status = 'APPROVED';
    action.approvedBy = userId;
    action.approvedAt = new Date().toISOString();
    await this.storage.save(action, previous);

    this.logger.log({
      msg: 'pending_action_approved',
      id,
      userId,
      toolName: action.toolName,
    });

    // Fase 2.5: enfileira execução real da tool. O processor
    // (PendingActionExecutorProcessor) resolve built-in vs HTTP skill,
    // executa com bypassPendingGate, salva executionResult e marca EXECUTED.
    try {
      await this.executorQueue.add(
        'execute_pending',
        { pendingActionId: id },
        { removeOnComplete: 100, removeOnFail: 50 },
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to enqueue executor for pending action ${id}: ${err?.message ?? err}`,
      );
      // Não rethrow — aprovação foi salva. Operador pode re-disparar via UI.
    }

    return action;
  }

  /**
   * Reject a pending action with a human-readable reason.
   */
  async reject(
    id: string,
    userId: string,
    reason: string,
  ): Promise<PendingAction> {
    if (!reason || !reason.trim()) {
      throw new BadRequestException('Rejection reason is required');
    }

    const action = await this.storage.get(id);
    if (!action) throw new NotFoundException('Pending action not found');

    if (action.status !== 'PENDING') {
      throw new BadRequestException(
        `Action is ${action.status} and cannot be rejected`,
      );
    }

    if (this.isExpired(action)) {
      const previous = action.status;
      action.status = 'EXPIRED';
      await this.storage.save(action, previous);
      throw new BadRequestException('Action expired');
    }

    const previous = action.status;
    action.status = 'REJECTED';
    action.rejectedBy = userId;
    action.rejectedAt = new Date().toISOString();
    action.rejectedReason = reason.trim();
    await this.storage.save(action, previous);

    this.logger.log({
      msg: 'pending_action_rejected',
      id,
      userId,
      toolName: action.toolName,
    });

    return action;
  }

  /** List PENDING actions, optionally filtered by conversation. */
  async listPending(conversationId?: string): Promise<PendingAction[]> {
    return this.storage.listByStatus('PENDING', conversationId);
  }

  /** List actions for a given status. */
  async listByStatus(
    status: PendingActionStatus,
    conversationId?: string,
  ): Promise<PendingAction[]> {
    return this.storage.listByStatus(status, conversationId);
  }

  /** List every action (any status) for a conversation. */
  async listForConversation(conversationId: string): Promise<PendingAction[]> {
    return this.storage.listByConversation(conversationId);
  }

  async get(id: string): Promise<PendingAction | null> {
    return this.storage.get(id);
  }

  /**
   * Check & sweep expirations.
   *
   * Walks every PENDING action, marks expired ones as EXPIRED, returns
   * the count moved. Cron-friendly (idempotent). Phase 2 will wire this
   * to a `@Cron('* * * * *')` runner.
   */
  async expireOverdue(): Promise<number> {
    const pending = await this.storage.listByStatus('PENDING');
    let moved = 0;
    for (const action of pending) {
      if (this.isExpired(action)) {
        const previous = action.status;
        action.status = 'EXPIRED';
        await this.storage.save(action, previous);
        moved++;
        this.logger.log({
          msg: 'pending_action_expired',
          id: action.id,
          toolName: action.toolName,
        });
      }
    }
    return moved;
  }

  /**
   * Recupera respostas ao cliente que EXPIRARAM sem nunca terem sido enviadas.
   *
   * Contexto: antes as respostas em modo revisão tinham TTL de 30 min; quem não
   * aprovava a tempo via o card virar EXPIRED e sumir da fila — e o cliente
   * ficava sem resposta. Este método traz de volta pra fila (PENDING, sem
   * expiração) SÓ os expirados cuja conversa continua **sem resposta**.
   *
   * Regra "sem resposta" = a conversa não tem NENHUMA mensagem OUTBOUND criada
   * depois do card ter sido gerado. Se houve outbound depois (resposta enviada
   * por outro caminho, ou um card mais novo aprovado), o expirado é ignorado.
   *
   * Idempotente: pode rodar quantas vezes quiser. Por conversa, ressuscita
   * apenas o card expirado MAIS RECENTE (evita empilhar respostas contraditórias),
   * e nunca ressuscita se já existir um PENDING pra aquela conversa.
   *
   * @returns { scanned, resurrected, conversationsAnswered }
   */
  async resurrectUnansweredReplies(): Promise<{
    scanned: number;
    resurrected: number;
    skippedAnswered: number;
    skippedHasPending: number;
  }> {
    const expired = await this.storage.listByStatus('EXPIRED');
    // Só respostas ao cliente. Já vêm ordenadas por createdAt desc.
    const replies = expired.filter(
      (a) => a.toolName === 'replyToConversation',
    );

    let resurrected = 0;
    let skippedAnswered = 0;
    let skippedHasPending = 0;
    const handledConversations = new Set<string>();

    for (const action of replies) {
      // Uma vez por conversa — a mais recente (primeira que aparece no desc).
      if (handledConversations.has(action.conversationId)) continue;
      handledConversations.add(action.conversationId);

      // Se já existe um PENDING pra essa conversa, não mexe (fluxo novo cuida).
      const pendingForConv = await this.storage.listByStatus(
        'PENDING',
        action.conversationId,
      );
      if (pendingForConv.some((p) => p.toolName === 'replyToConversation')) {
        skippedHasPending++;
        continue;
      }

      // "Sem resposta" = nenhuma mensagem OUTBOUND depois do card ter sido gerado.
      const answeredAfter = await this.prisma.message.findFirst({
        where: {
          conversationId: action.conversationId,
          direction: MessageDirection.OUTBOUND,
          createdAt: { gt: new Date(action.createdAt) },
        },
        select: { id: true },
      });
      if (answeredAfter) {
        skippedAnswered++;
        continue;
      }

      // Ressuscita: volta pra fila SEM expiração.
      action.status = 'PENDING';
      action.expiresAt = this.NEVER_EXPIRES_ISO;
      await this.storage.save(action, 'EXPIRED');
      resurrected++;
      this.logger.log({
        msg: 'pending_action_resurrected',
        id: action.id,
        conversationId: action.conversationId,
      });
    }

    this.logger.log(
      `Recuperação de respostas: ${resurrected} reativadas, ${skippedAnswered} já respondidas, ${skippedHasPending} já tinham pendente (de ${replies.length} expiradas)`,
    );

    return {
      scanned: replies.length,
      resurrected,
      skippedAnswered,
      skippedHasPending,
    };
  }

  private isExpired(action: PendingAction): boolean {
    return new Date(action.expiresAt).getTime() < Date.now();
  }
}
