-- TenderFlow v1 schema (docs/BUILD-SPEC.md §5)

CREATE TABLE tenants (
  id            text PRIMARY KEY,
  name_en       text NOT NULL,
  name_ar       text NOT NULL,
  primary_color text NOT NULL DEFAULT '#0B4F6C',
  status        text NOT NULL DEFAULT 'ACTIVE',
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vendors (
  id              uuid PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants(id),
  legal_name_en   text NOT NULL,
  legal_name_ar   text NOT NULL,
  cr_number       text NOT NULL,
  email           text NOT NULL,
  phone           text,
  categories      text[] NOT NULL DEFAULT '{}',
  status          text NOT NULL DEFAULT 'PENDING_REVIEW'
                  CHECK (status IN ('PENDING_REVIEW','APPROVED','REJECTED')),
  decision_reason text,
  decided_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  decided_at      timestamptz,
  UNIQUE (tenant_id, cr_number)
);

CREATE TABLE users (
  id            uuid PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants(id),
  username      text NOT NULL,
  password_hash text NOT NULL,
  display_name  text NOT NULL,
  roles         text[] NOT NULL,
  vendor_id     uuid REFERENCES vendors(id),
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, username)
);

CREATE TABLE signing_keys (
  kid         text PRIMARY KEY,
  private_pem text NOT NULL,
  public_jwk  jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE tenders (
  id                  uuid PRIMARY KEY,
  tenant_id           text NOT NULL REFERENCES tenants(id),
  tender_number       text NOT NULL,
  title_en            text NOT NULL,
  title_ar            text NOT NULL,
  description_en      text NOT NULL DEFAULT '',
  description_ar      text NOT NULL DEFAULT '',
  category            text NOT NULL,
  estimated_budget    numeric,
  currency            text NOT NULL DEFAULT 'KWD',
  submission_deadline timestamptz NOT NULL,
  criteria            jsonb NOT NULL DEFAULT '[]',
  required_documents  jsonb NOT NULL DEFAULT '[]',
  status              text NOT NULL DEFAULT 'DRAFT'
                      CHECK (status IN ('DRAFT','APPROVED','PUBLISHED','CLOSED','OPENED','EVALUATION','AWARDED','CANCELLED')),
  created_by          uuid NOT NULL,
  approved_by         uuid,
  published_at        timestamptz,
  closed_at           timestamptz,
  opened_at           timestamptz,
  awarded_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, tender_number)
);

CREATE TABLE bids (
  id             uuid PRIMARY KEY,
  tenant_id      text NOT NULL REFERENCES tenants(id),
  tender_id      uuid NOT NULL REFERENCES tenders(id),
  vendor_id      uuid NOT NULL REFERENCES vendors(id),
  status         text NOT NULL DEFAULT 'SEALED' CHECK (status IN ('SEALED','OPENED')),
  wrapped_key    text NOT NULL,
  wrap_iv        text NOT NULL,
  wrap_tag       text NOT NULL,
  receipt_sha256 text NOT NULL,
  submitted_at   timestamptz NOT NULL,
  opened_at      timestamptz,
  UNIQUE (tender_id, vendor_id)
);

CREATE TABLE documents (
  id           uuid PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id),
  owner_type   text NOT NULL CHECK (owner_type IN ('VENDOR','TENDER_PACK','ADDENDUM','BID_TECHNICAL','BID_FINANCIAL','OPENING_RECORD','COMMITTEE_REPORT')),
  owner_id     uuid NOT NULL,
  tender_id    uuid REFERENCES tenders(id),
  vendor_id    uuid REFERENCES vendors(id),
  bid_id       uuid REFERENCES bids(id),
  title        text NOT NULL,
  mime_type    text NOT NULL,
  byte_size    integer NOT NULL,
  sha256_plain text NOT NULL,
  store_type   text NOT NULL,
  store_ref    text NOT NULL,
  encrypted    boolean NOT NULL DEFAULT false,
  enc_iv       text,
  enc_tag      text,
  uploaded_by  uuid,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX documents_tender_idx ON documents (tenant_id, tender_id);
CREATE INDEX documents_bid_idx ON documents (bid_id);

CREATE TABLE ai_runs (
  id              uuid PRIMARY KEY,
  tenant_id       text NOT NULL REFERENCES tenants(id),
  tender_id       uuid REFERENCES tenders(id),
  kind            text NOT NULL CHECK (kind IN ('PACK_CHECK','CLARIFICATION_DRAFT','COMPLIANCE_SCREEN')),
  agent           text,
  model           text,
  request         jsonb NOT NULL DEFAULT '{}',
  response        jsonb,
  citations       jsonb NOT NULL DEFAULT '[]',
  status          text NOT NULL CHECK (status IN ('OK','ERROR')),
  error           text,
  requested_by    uuid,
  reviewed_by     uuid,
  review_decision text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE clarifications (
  id          uuid PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants(id),
  tender_id   uuid NOT NULL REFERENCES tenders(id),
  vendor_id   uuid NOT NULL REFERENCES vendors(id),
  question    text NOT NULL,
  language    text NOT NULL,
  answer      text,
  answered_by uuid,
  status      text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','ANSWERED')),
  ai_run_id   uuid REFERENCES ai_runs(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  answered_at timestamptz
);

CREATE TABLE openings (
  id                 uuid PRIMARY KEY,
  tenant_id          text NOT NULL REFERENCES tenants(id),
  tender_id          uuid NOT NULL UNIQUE REFERENCES tenders(id),
  chair_id           uuid NOT NULL,
  attendees          jsonb NOT NULL DEFAULT '[]',
  notes              text,
  record_document_id uuid REFERENCES documents(id),
  opened_at          timestamptz NOT NULL
);

CREATE TABLE evaluations (
  id             uuid PRIMARY KEY,
  tenant_id      text NOT NULL REFERENCES tenants(id),
  tender_id      uuid NOT NULL REFERENCES tenders(id),
  bid_id         uuid NOT NULL REFERENCES bids(id),
  evaluator_id   uuid NOT NULL,
  scores         jsonb NOT NULL,
  weighted_total numeric NOT NULL,
  submitted_at   timestamptz NOT NULL,
  UNIQUE (bid_id, evaluator_id)
);

CREATE TABLE awards (
  id                 uuid PRIMARY KEY,
  tenant_id          text NOT NULL REFERENCES tenants(id),
  tender_id          uuid NOT NULL UNIQUE REFERENCES tenders(id),
  bid_id             uuid NOT NULL REFERENCES bids(id),
  recommended_by     uuid NOT NULL,
  justification      text NOT NULL,
  approved_by        uuid,
  status             text NOT NULL CHECK (status IN ('RECOMMENDED','APPROVED')),
  report_document_id uuid REFERENCES documents(id),
  created_at         timestamptz NOT NULL DEFAULT now(),
  approved_at        timestamptz
);

CREATE TABLE audit_events (
  seq           bigserial PRIMARY KEY,
  id            uuid NOT NULL UNIQUE,
  tenant_id     text NOT NULL,
  actor_id      text NOT NULL,
  actor_roles   text[] NOT NULL DEFAULT '{}',
  action        text NOT NULL,
  resource_type text NOT NULL,
  resource_id   text,
  prev_state    text,
  new_state     text,
  reason        text,
  details       jsonb NOT NULL DEFAULT '{}',
  at            timestamptz NOT NULL,
  prev_hmac     text,
  hmac          text NOT NULL
);
CREATE INDEX audit_events_tenant_idx ON audit_events (tenant_id, seq);
CREATE INDEX audit_events_resource_idx ON audit_events (tenant_id, resource_id);

CREATE FUNCTION audit_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% not allowed)', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_events_no_update_delete
  BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_append_only();

CREATE TRIGGER audit_events_no_truncate
  BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_append_only();
