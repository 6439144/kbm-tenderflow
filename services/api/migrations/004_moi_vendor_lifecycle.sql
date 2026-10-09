-- TenderFlow — entity policies + vendor lifecycle (MOI reference configuration, generic for every entity).
-- Entity policies: eligibility semantics, subscription, exemption, blocking, content protection, function-to-role
-- mapping. Vendor lifecycle: grading, annual subscription with payment link, renewal reminders, grade upgrade
-- requests, fee exemption (per vendor or vendor category), blocking with automatic reinstatement.

-- One row per entity; absent row = product defaults (identical to TenderFlow v1.0 behaviour).
CREATE TABLE entity_policies (
  tenant_id   text PRIMARY KEY REFERENCES tenants(id),
  policies    jsonb NOT NULL DEFAULT '{}',
  reference   text,                 -- requirements catalogue the settings are annotated against (e.g. 'MOI-BRD-v0.1')
  updated_by  text,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

-- Vendor categories (fee exemption by category, FR-018 option B).
CREATE TABLE vendor_categories (
  tenant_id  text NOT NULL REFERENCES tenants(id),
  code       text NOT NULL,
  name_en    text NOT NULL,
  name_ar    text NOT NULL,
  fee_exempt boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, code)
);

ALTER TABLE vendors ADD COLUMN company_grade integer CHECK (company_grade BETWEEN 1 AND 3);
ALTER TABLE vendors ADD COLUMN vendor_category text;
ALTER TABLE vendors ADD COLUMN fee_exempt boolean NOT NULL DEFAULT false;
ALTER TABLE vendors ADD COLUMN fee_exempt_reason text;
ALTER TABLE vendors ADD COLUMN graded_by uuid;
ALTER TABLE vendors ADD COLUMN graded_at timestamptz;

-- Annual subscription (FR-017, BR-008/009). A period is issued as a payment link (PENDING_PAYMENT) and becomes
-- ACTIVE when paid (TEST gateway in the demo; KNET refused until a merchant is configured), then EXPIRED.
CREATE TABLE vendor_subscriptions (
  id             uuid PRIMARY KEY,
  tenant_id      text NOT NULL REFERENCES tenants(id),
  vendor_id      uuid NOT NULL REFERENCES vendors(id),
  kind           text NOT NULL CHECK (kind IN ('NEW','RENEWAL')),
  status         text NOT NULL CHECK (status IN ('PENDING_PAYMENT','ACTIVE','EXPIRED','CANCELLED')),
  link_token     text NOT NULL UNIQUE,
  amount         numeric NOT NULL,
  currency       text NOT NULL,
  gateway        text CHECK (gateway IN ('TEST','KNET','EXEMPT')),
  payment_ref    text,
  receipt_number text,
  approved_at    timestamptz,       -- grading approval (start date when the policy says APPROVAL_DATE)
  starts_at      timestamptz,
  ends_at        timestamptz,
  paused_days    integer NOT NULL DEFAULT 0,
  issued_by      text,
  paid_by        uuid,
  paid_at        timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, receipt_number)
);
CREATE INDEX vendor_subscriptions_vendor_idx ON vendor_subscriptions (tenant_id, vendor_id, status);

-- NOT-001: one reminder per (subscription, threshold in days).
CREATE TABLE subscription_reminders (
  subscription_id uuid NOT NULL REFERENCES vendor_subscriptions(id),
  threshold_days  integer NOT NULL,
  sent_at         timestamptz NOT NULL,
  PRIMARY KEY (subscription_id, threshold_days)
);

-- FR-010: grade upgrade requests with supporting documents (documents.owner_type = 'VENDOR').
CREATE TABLE grade_upgrade_requests (
  id              uuid PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants(id),
  vendor_id       uuid NOT NULL REFERENCES vendors(id),
  request_number  text NOT NULL,
  activity_code   text,             -- null = company-wide grade
  current_grade   integer,
  requested_grade integer NOT NULL CHECK (requested_grade BETWEEN 1 AND 3),
  justification   text NOT NULL DEFAULT '',
  document_ids    uuid[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','APPROVED','REJECTED')),
  requested_by    uuid NOT NULL,
  decided_by      uuid,
  decision_reason text,
  granted_grade   integer,
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  UNIQUE (tenant_id, request_number)
);

-- FR-013/014, BR-006: blocking (date range or permanent) with automatic reinstatement at the end date.
CREATE TABLE vendor_blocks (
  id            uuid PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants(id),
  vendor_id     uuid NOT NULL REFERENCES vendors(id),
  mode          text NOT NULL CHECK (mode IN ('DATE_RANGE','PERMANENT')),
  starts_at     timestamptz NOT NULL,
  ends_at       timestamptz,
  ground        text,
  reason        text NOT NULL,
  authorised_by uuid NOT NULL,
  status        text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ENDED','LIFTED')),
  ended_at      timestamptz,
  lifted_by     uuid,
  lift_reason   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (mode = 'PERMANENT' OR ends_at IS NOT NULL)
);
CREATE INDEX vendor_blocks_vendor_idx ON vendor_blocks (tenant_id, vendor_id, status);
