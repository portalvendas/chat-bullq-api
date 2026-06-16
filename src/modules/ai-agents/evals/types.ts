/**
 * Canonical types for the agent evals system. These types are the contract
 * shared across runner, judge, reporter and any external dataset format.
 *
 * Keep them stable — other modules (datasets fixtures, CI scripts, future
 * dashboards) depend on this exact shape.
 */

export interface EvalAssertion {
  /** Tools that MUST be called (order-independent). */
  toolCalls?: string[];
  /** Tools that MUST NOT be called. */
  shouldNotCall?: string[];
  /** Substrings that must appear in the agent's last message. */
  messageContains?: string[];
  /** Substrings that must NOT appear in the agent's last message. */
  messageNotContains?: string[];
  /** Final action the runner should produce. */
  finalAction?:
    | 'REPLIED'
    | 'DELEGATED'
    | 'TRANSFERRED_TO_HUMAN'
    | 'HANDED_BACK'
    | 'IGNORED';
  /** Target agent name when finalAction === 'DELEGATED'. */
  delegateTo?: string;
  /** Subjective question routed to the LLM-as-judge. */
  judgeQuestion?: string;
  /** Required verdict from the judge. */
  judgeMustBe?: 'pass' | 'fail';
}

export interface EvalCase {
  name: string;
  /** Simulated customer message. */
  input: string;
  /** Optional fixture id loading conversation history. */
  conversationContext?: string;
  expect: EvalAssertion;
}

export interface EvalDataset {
  /** Name of the agent under test, e.g. 'Augusto Mendes', 'Daniel Souza'. */
  agentName: string;
  cases: EvalCase[];
}

export interface EvalAgentResponse {
  toolCalls: { name: string; args: any }[];
  finalMessage: string;
  finalAction: string;
}

export interface EvalResult {
  case: EvalCase;
  passed: boolean;
  /** Human-readable failure descriptions, one per failed assertion. */
  failures: string[];
  agentResponse: EvalAgentResponse;
  costUsd: number;
  durationMs: number;
}

export interface EvalRunReport {
  agentName: string;
  datasetName: string;
  totalCases: number;
  passed: number;
  failed: number;
  scorePercent: number;
  totalCostUsd: number;
  totalDurationMs: number;
  results: EvalResult[];
  generatedAt: Date;
}

/**
 * Verdict returned by the LLM-as-judge for subjective assertions.
 */
export interface JudgeVerdict {
  verdict: 'pass' | 'fail';
  reasoning: string;
}
