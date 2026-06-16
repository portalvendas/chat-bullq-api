// Single source of truth for all magic strings/numbers used by the
// automation engine. Keep this file dependency-free so it can be imported
// from anywhere (services, processors, tests, future UI fixtures).

export const AUTOMATION_QUEUE = 'automation-events';

// Cascade depth: number of automation hops in a single trace. Original
// domain events start at 0; every action that re-emits an event increments.
// Worker refuses to execute when depth would exceed this.
export const MAX_CASCADE_DEPTH = 4;

// Auto-disable threshold: an automation with this many failed runs in a
// row gets paused until a human re-enables it.
export const AUTO_DISABLE_AFTER_FAILURES = 5;

// Outbox poller cadence (ms). Tuned for "feels real-time" without
// hammering the DB. Each tick claims a small batch.
export const OUTBOX_POLL_INTERVAL_MS = 1_000;
export const OUTBOX_POLL_BATCH_SIZE = 50;

// How long the poller's lease on a row lasts. If the worker dies
// mid-processing, the lease expires and another poller can re-claim.
export const OUTBOX_LEASE_TTL_MS = 60_000;

// Redis lock TTL on the per-contact mutex. Should comfortably exceed the
// expected execution time of a chain of actions (incl. external HTTP).
export const CONTACT_LOCK_TTL_MS = 30_000;

// Run retention window — runs older than this are eligible for cleanup.
// Cleanup itself ships in a later PR (cron job or DB-side TTL).
export const RUN_RETENTION_DAYS = 90;

// Currently supported schema version. Worker refuses to run automations
// with a different version (forces migration before execution).
export const CURRENT_AUTOMATION_SCHEMA_VERSION = 1;
