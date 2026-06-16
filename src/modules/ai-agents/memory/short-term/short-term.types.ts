/**
 * Short-term (working) memory for AI agents.
 *
 * The DB (Prisma `messages`) remains the source of truth. Redis is a hot
 * cache of the last N messages of a conversation so the agent runner does
 * not have to round-trip Postgres on every turn.
 */

export type StoredMessageRole = 'user' | 'assistant' | 'tool' | 'system';

export interface StoredMessage {
  /** Message id (usually the DB row id). Used for de-dup if ever needed. */
  id: string;
  role: StoredMessageRole;
  /** Plain text content. Tool messages carry the tool result here. */
  content: string;
  /** Set when role === 'tool': id of the tool_call this message answers. */
  toolCallId?: string;
  /** Set when role === 'tool' or 'assistant' (call): tool name. */
  toolName?: string;
  /** ISO 8601 timestamp. */
  createdAt: string;
}

export interface ShortTermConfig {
  /** Maximum number of messages kept per conversation in Redis. */
  maxMessages: number;
  /** TTL applied (and refreshed) on every append, in seconds. */
  ttlSeconds: number;
}
