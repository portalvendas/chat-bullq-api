import { Injectable } from '@nestjs/common';
import { IntentType } from './intent.types';

/**
 * Mapeia um intent classificado pro nome do agente que deve atender e diz
 * se o orchestrator (Augusto) pode ser pulado.
 *
 * Decisão de "skip" é binária aqui — o threshold de confidence é aplicado
 * pelo IntentClassifierService antes de gerar o ClassificationResult final.
 * Esse service é puro lookup.
 */
@Injectable()
export class IntentRouterService {
  private static readonly MAP: Record<
    IntentType,
    { agentName: string; skip: boolean }
  > = {
    [IntentType.SALES_GENERAL]: { agentName: 'Daniel Souza', skip: true },
    [IntentType.SALES_ACCOUNTING]: { agentName: 'André Silva', skip: true },
    [IntentType.SALES_LEGAL]: { agentName: 'Bruno Costa', skip: true },
    [IntentType.SUPPORT]: { agentName: 'Lívia Andrade', skip: true },
    [IntentType.IMPLEMENTATION]: { agentName: 'Sofia Almeida', skip: true },
    // Augusto cuida — orchestrator decide a próxima jogada.
    [IntentType.SMALL_TALK]: { agentName: 'Augusto Mendes', skip: false },
    [IntentType.AMBIGUOUS]: { agentName: 'Augusto Mendes', skip: false },
    [IntentType.SPAM_OR_NOISE]: { agentName: 'Augusto Mendes', skip: false },
    [IntentType.ESCALATE_HUMAN]: { agentName: 'Augusto Mendes', skip: false },
  };

  routeIntent(intent: IntentType): {
    agentName: string;
    shouldSkipOrchestrator: boolean;
  } {
    const r = IntentRouterService.MAP[intent];
    return {
      agentName: r.agentName,
      shouldSkipOrchestrator: r.skip,
    };
  }
}
