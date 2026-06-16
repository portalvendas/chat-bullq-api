-- Automations foundation (PR 1)
--
-- Adds the rule engine plumbing without exposing it to users yet.
-- Listener emits events into outbox_events; worker is a no-op until PR 2.
-- Existing tables are NOT touched. Safe to deploy on a live database.

-- ─── Enums ────────────────────────────────────────────────────────────

CREATE TYPE "AutomationTrigger" AS ENUM (
  'TAG_ADDED',
  'TAG_REMOVED',
  'MESSAGE_RECEIVED',
  'CONVERSATION_STATUS_CHANGED',
  'CONVERSATION_ASSIGNED'
);

CREATE TYPE "AutomationRunStatus" AS ENUM (
  'SUCCESS',
  'PARTIAL',
  'FAILED',
  'SKIPPED'
);

CREATE TYPE "OutboxEventStatus" AS ENUM (
  'PENDING',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
  'DLQ'
);

-- ─── outbox_events ────────────────────────────────────────────────────

CREATE TABLE "outbox_events" (
  "id"              TEXT                NOT NULL,
  "organization_id" TEXT                NOT NULL,
  "trigger"         "AutomationTrigger" NOT NULL,
  "payload"         JSONB               NOT NULL,
  "dedup_key"       TEXT,
  "trace_id"        TEXT                NOT NULL,
  "cascade_depth"   INTEGER             NOT NULL DEFAULT 0,
  "actor_id"        TEXT,
  "status"          "OutboxEventStatus" NOT NULL DEFAULT 'PENDING',
  "attempt_count"   INTEGER             NOT NULL DEFAULT 0,
  "last_error"      TEXT,
  "leased_by"       TEXT,
  "leased_until"    TIMESTAMP(3),
  "created_at"      TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processed_at"    TIMESTAMP(3),

  CONSTRAINT "outbox_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "outbox_events_dedup_key_key"
  ON "outbox_events" ("dedup_key");

CREATE INDEX "idx_outbox_status_time"
  ON "outbox_events" ("status", "created_at");

CREATE INDEX "idx_outbox_org_trigger"
  ON "outbox_events" ("organization_id", "trigger", "created_at" DESC);

CREATE INDEX "idx_outbox_trace"
  ON "outbox_events" ("trace_id");

-- ─── automations ──────────────────────────────────────────────────────

CREATE TABLE "automations" (
  "id"                    TEXT                NOT NULL,
  "organization_id"       TEXT                NOT NULL,
  "name"                  TEXT                NOT NULL,
  "description"           TEXT,
  "trigger"               "AutomationTrigger" NOT NULL,
  "conditions"            JSONB               NOT NULL DEFAULT '{}',
  "actions"               JSONB               NOT NULL DEFAULT '[]',
  "schema_version"        INTEGER             NOT NULL DEFAULT 1,
  "enabled"               BOOLEAN             NOT NULL DEFAULT false,
  "actor_id"              TEXT                NOT NULL,
  "priority"              INTEGER             NOT NULL DEFAULT 0,
  "consecutive_failures"  INTEGER             NOT NULL DEFAULT 0,
  "auto_paused_at"        TIMESTAMP(3),
  "auto_paused_reason"    TEXT,
  "rate_limit_per_minute" INTEGER             NOT NULL DEFAULT 10,
  "last_run_at"           TIMESTAMP(3),
  "run_count"             INTEGER             NOT NULL DEFAULT 0,
  "success_count"         INTEGER             NOT NULL DEFAULT 0,
  "failure_count"         INTEGER             NOT NULL DEFAULT 0,
  "created_at"            TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at"            TIMESTAMP(3)        NOT NULL,
  "deleted_at"            TIMESTAMP(3),

  CONSTRAINT "automations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_automation_org_enabled"
  ON "automations" ("organization_id", "enabled", "trigger");

CREATE INDEX "idx_automation_org_deleted"
  ON "automations" ("organization_id", "deleted_at");

-- ─── automation_runs ──────────────────────────────────────────────────

CREATE TABLE "automation_runs" (
  "id"               TEXT                  NOT NULL,
  "automation_id"    TEXT                  NOT NULL,
  "organization_id"  TEXT                  NOT NULL,
  "outbox_event_id"  TEXT                  NOT NULL,
  "trace_id"         TEXT                  NOT NULL,
  "status"           "AutomationRunStatus" NOT NULL,
  "error_code"       TEXT,
  "error_message"    TEXT,
  "trigger_payload"  JSONB                 NOT NULL,
  "actions_log"      JSONB                 NOT NULL DEFAULT '[]',
  "duration_ms"      INTEGER,
  "started_at"       TIMESTAMP(3)          NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at"      TIMESTAMP(3),

  CONSTRAINT "automation_runs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "idx_run_automation_time"
  ON "automation_runs" ("automation_id", "started_at" DESC);

CREATE INDEX "idx_run_org_time"
  ON "automation_runs" ("organization_id", "started_at" DESC);

CREATE INDEX "idx_run_trace"
  ON "automation_runs" ("trace_id");

CREATE INDEX "idx_run_status_time"
  ON "automation_runs" ("status", "started_at" DESC);

-- ─── FK ──────────────────────────────────────────────────────────────

ALTER TABLE "automation_runs"
  ADD CONSTRAINT "automation_runs_automation_id_fkey"
  FOREIGN KEY ("automation_id") REFERENCES "automations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
