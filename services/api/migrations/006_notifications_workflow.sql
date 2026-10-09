-- TenderFlow Phase 2 (NOTIFY) — notification templates and channels, delivery log, durable background jobs,
-- approval service levels (SLA) with reminders and escalation records.

-- Notification templates: one row per entity (tenant) and event code. IN_APP is always delivered while the template
-- is enabled; EMAIL / SMS are delivered when listed in `channels` AND the channel is configured on the server.
CREATE TABLE notification_templates (
  id          uuid PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants(id),
  code        text NOT NULL,
  audience    text NOT NULL DEFAULT 'STAFF' CHECK (audience IN ('VENDOR','STAFF')),
  channels    text[] NOT NULL DEFAULT '{IN_APP}',
  enabled     boolean NOT NULL DEFAULT true,
  subject_en  text NOT NULL,
  subject_ar  text NOT NULL,
  body_en     text NOT NULL,
  body_ar     text NOT NULL,
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

-- Delivery log: one row per notification, channel and recipient. QUEUED rows are sent (and retried with exponential
-- back-off, max 3 attempts) by the `notification-deliveries` job. A channel that is not configured is recorded as
-- SKIPPED_NOT_CONFIGURED and is never reported as SENT.
CREATE TABLE notification_deliveries (
  id                  uuid PRIMARY KEY,
  tenant_id           text NOT NULL REFERENCES tenants(id),
  notification_id     uuid,
  template_code       text NOT NULL,
  channel             text NOT NULL CHECK (channel IN ('IN_APP','EMAIL','SMS')),
  recipient_user_id   uuid,
  recipient_vendor_id uuid,
  recipient_label     text,
  address             text,
  lang                text NOT NULL DEFAULT 'ar',
  subject             text NOT NULL DEFAULT '',
  body                text NOT NULL DEFAULT '',
  status              text NOT NULL CHECK (status IN ('QUEUED','SENT','FAILED','SKIPPED_NOT_CONFIGURED','SKIPPED_NO_ADDRESS')),
  provider_message_id text,
  error               text,
  attempts            integer NOT NULL DEFAULT 0,
  next_attempt_at     timestamptz,
  locked_until        timestamptz,
  is_test             boolean NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  sent_at             timestamptz
);
CREATE INDEX notification_deliveries_tenant_idx ON notification_deliveries (tenant_id, created_at DESC);
CREATE INDEX notification_deliveries_queue_idx ON notification_deliveries (status, next_attempt_at);

-- Notification contact details for staff users (vendors use the e-mail / phone of their vendor record).
CREATE TABLE notification_contacts (
  tenant_id  text NOT NULL REFERENCES tenants(id),
  user_id    uuid NOT NULL,
  email      text,
  phone      text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id)
);

-- Durable background jobs (services/scheduler.ts). `locked_until` is the single-run guard (works for PGlite and pg).
CREATE TABLE scheduled_jobs (
  name             text PRIMARY KEY,
  every_ms         integer NOT NULL,
  locked_until     timestamptz,
  locked_by        text,
  last_started_at  timestamptz,
  last_finished_at timestamptz,
  last_status      text CHECK (last_status IN ('OK','ERROR')),
  last_result      jsonb,
  last_error       text,
  run_count        integer NOT NULL DEFAULT 0,
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- Approval service levels per entity. Level-specific `dueHours` in the cycle template wins over default_due_hours.
CREATE TABLE approval_sla_settings (
  tenant_id           text PRIMARY KEY REFERENCES tenants(id),
  default_due_hours   numeric,
  escalate_to         text NOT NULL DEFAULT 'NEXT_LEVEL_ROLE',
  remind_before_hours numeric,
  updated_by          text,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- Reminder / escalation records: at most one of each kind per waiting level (a level that waits again after a
-- return starts a new clock, hence `waiting_since` in the key). The approval itself is never changed.
CREATE TABLE approval_escalations (
  id            uuid PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants(id),
  subject_type  text NOT NULL CHECK (subject_type IN ('TENDER','REQUEST')),
  subject_id    uuid NOT NULL,
  gate          text NOT NULL,
  level         integer NOT NULL,
  role          text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('REMINDER','ESCALATION')),
  waiting_since timestamptz NOT NULL,
  due_at        timestamptz NOT NULL,
  escalated_to  text,
  notified      integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, subject_id, gate, level, waiting_since, kind)
);
CREATE INDEX approval_escalations_subject_idx ON approval_escalations (tenant_id, subject_id);
