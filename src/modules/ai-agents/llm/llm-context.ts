import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Contexto de organização para chamadas de LLM.
 *
 * BYOK (bring-your-own-key): cada empresa usa a PRÓPRIA chave da Anthropic.
 * O `LlmService` precisa saber a qual org uma chamada pertence para resolver
 * a chave certa — mas há dezenas de call sites aninhados (classifier, runner,
 * reranker, memória) onde passar `organizationId` explicitamente seria
 * invasivo e frágil.
 *
 * Solução: um AsyncLocalStorage setado UMA vez no ponto de entrada de cada
 * pipeline de IA (processor de mensagem inbound, job de auditoria de funil,
 * extração de memória, etc). Todas as chamadas `llm.complete()` aninhadas
 * dentro do `LlmContext.run(orgId, fn)` enxergam o mesmo `organizationId`
 * automaticamente, sem threading manual.
 *
 * Precedência no LlmService: `req.organizationId` explícito > contexto ALS.
 */
interface LlmContextData {
  organizationId: string;
}

const storage = new AsyncLocalStorage<LlmContextData>();

export const LlmContext = {
  /** Executa `fn` com o contexto de org ativo (propaga por todo o await tree). */
  run<T>(organizationId: string, fn: () => T): T {
    return storage.run({ organizationId }, fn);
  },
  /** organizationId do contexto atual, se houver. */
  organizationId(): string | undefined {
    return storage.getStore()?.organizationId;
  },
};
