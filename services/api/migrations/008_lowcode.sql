-- TenderFlow Low-code Process Studio (docs/LOW-CODE-STUDIO.md).
-- Entities customise their process without code: custom forms (fields on tenders, requests and vendors), business rules
-- (gate guards, conditional approval routing, event automations), tasks, and outbound webhooks. Every definition is
-- versioned (DRAFT → PUBLISHED → RETIRED), validated by the server and audited. The fixed integrity rules (sealed bids,
-- opening by the chair after the deadline, segregation of duties, append-only audit) are not configurable: rules can
-- only ADD controls (extra approval levels, blocks, required fields, tasks, notifications), never remove one.

-- Versioned low-code definitions. kind FORM: code = TENDER | REQUEST | VENDOR. kind RULESET: code = PROCESS.
CREATE TABLE lowcode_definitions (
  id            uuid PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants(id),
  kind          text NOT NULL CHECK (kind IN ('FORM','RULESET')),
  code          text NOT NULL,
  version       integer NOT NULL,
  status        text NOT NULL CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  name_en       text NOT NULL,
  name_ar       text NOT NULL,
  definition    jsonb NOT NULL,
  created_by    text NOT NULL,
  updated_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  published_by  text,
  published_at  timestamptz,
  UNIQUE (tenant_id, kind, code, version)
);
CREATE INDEX lowcode_definitions_live ON lowcode_definitions (tenant_id, kind, code, status);

-- Custom field values (validated against the form version pinned on the object) and the rule snapshot / routing a
-- tender keeps for its whole life (later rule edits never change a running tender).
ALTER TABLE tenders ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE tenders ADD COLUMN custom_form jsonb;
ALTER TABLE tenders ADD COLUMN process_snapshot jsonb;
ALTER TABLE tenders ADD COLUMN routing jsonb;
ALTER TABLE procurement_requests ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE procurement_requests ADD COLUMN custom_form jsonb;
ALTER TABLE vendors ADD COLUMN custom_fields jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE vendors ADD COLUMN custom_form jsonb;

-- Tasks created by rules (CREATE_TASK). A task may block a gate (TENDER_PUBLISH / AWARD_RECOMMEND) until it is done.
CREATE TABLE lowcode_tasks (
  id            uuid PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants(id),
  subject_type  text NOT NULL,
  subject_id    uuid NOT NULL,
  subject_ref   text,
  rule_id       text NOT NULL,
  ruleset_version integer,
  title_en      text NOT NULL,
  title_ar      text NOT NULL,
  role          text NOT NULL,
  blocks_gate   text,
  due_at        timestamptz,
  status        text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','DONE','CANCELLED')),
  completed_by  text,
  completed_at  timestamptz,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lowcode_tasks_open ON lowcode_tasks (tenant_id, status, role);
CREATE INDEX lowcode_tasks_subject ON lowcode_tasks (subject_id, status);

-- Automation log: one row per rule that matched (gate or event), with the outcome of each action.
CREATE TABLE lowcode_runs (
  id            uuid PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants(id),
  trigger       text NOT NULL,
  rule_id       text NOT NULL,
  rule_name     text NOT NULL,
  ruleset_version integer,
  subject_type  text,
  subject_id    text,
  subject_ref   text,
  audit_seq     bigint,
  outcome       jsonb NOT NULL DEFAULT '[]'::jsonb,
  status        text NOT NULL CHECK (status IN ('OK','PARTIAL','ERROR','BLOCKED')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX lowcode_runs_recent ON lowcode_runs (tenant_id, created_at DESC);

-- Where the event automation has read the audit trail up to (per entity), and once-only firings (schedules).
CREATE TABLE lowcode_cursor (
  tenant_id     text PRIMARY KEY REFERENCES tenants(id),
  last_seq      bigint NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE lowcode_firings (
  tenant_id     text NOT NULL REFERENCES tenants(id),
  rule_id       text NOT NULL,
  subject_id    text NOT NULL,
  fired_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, rule_id, subject_id)
);

-- Outbound integrations: an endpoint receives signed JSON events (HMAC-SHA256). The signing secret is stored encrypted
-- (AES-256-GCM, key derived from AUDIT_SIGNING_KEY) and shown once when created or rotated.
CREATE TABLE webhook_endpoints (
  id            uuid PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants(id),
  code          text NOT NULL,
  name          text NOT NULL,
  url           text NOT NULL,
  events        text[] NOT NULL DEFAULT '{}',
  enabled       boolean NOT NULL DEFAULT true,
  secret_enc    text NOT NULL,
  secret_iv     text NOT NULL,
  secret_tag    text NOT NULL,
  created_by    text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

CREATE TABLE webhook_deliveries (
  id            uuid PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants(id),
  endpoint_id   uuid NOT NULL REFERENCES webhook_endpoints(id),
  event         text NOT NULL,
  payload       jsonb NOT NULL,
  status        text NOT NULL DEFAULT 'QUEUED' CHECK (status IN ('QUEUED','SENT','FAILED','DEAD')),
  attempts      integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  last_status   integer,
  last_error    text,
  sent_at       timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX webhook_deliveries_due ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX webhook_deliveries_recent ON webhook_deliveries (tenant_id, created_at DESC);
