-- TenderFlow v1.1 — generic multi-entity platform (cycle templates, approval chains, eligibility,
-- request intake, publication channels, two-envelope opening, records lock, document versions).

-- Entity profile (numbering pattern, channels, identity provider, branding extras).
ALTER TABLE tenants ADD COLUMN profile jsonb NOT NULL DEFAULT '{}';

-- Cycle templates: versioned; a tender pins the version (snapshot) it was created with.
CREATE TABLE cycle_templates (
  id           uuid PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id),
  code         text NOT NULL,
  version      integer NOT NULL,
  name_en      text NOT NULL,
  name_ar      text NOT NULL,
  description  text NOT NULL DEFAULT '',
  config       jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','PUBLISHED','RETIRED')),
  is_default   boolean NOT NULL DEFAULT false,
  created_by   text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz,
  UNIQUE (tenant_id, code, version)
);
CREATE INDEX cycle_templates_tenant_idx ON cycle_templates (tenant_id, status);

ALTER TABLE tenders ADD COLUMN template_id uuid REFERENCES cycle_templates(id);
ALTER TABLE tenders ADD COLUMN template_snapshot jsonb;
ALTER TABLE tenders ADD COLUMN request_id uuid;
ALTER TABLE tenders ADD COLUMN eligibility jsonb NOT NULL DEFAULT '{}';
ALTER TABLE tenders ADD COLUMN financial_opened_at timestamptz;
ALTER TABLE tenders ADD COLUMN records_locked_at timestamptz;

ALTER TABLE tenders DROP CONSTRAINT tenders_status_check;
ALTER TABLE tenders ADD CONSTRAINT tenders_status_check
  CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','PUBLISHED','CLOSED','OPENED','EVALUATION','AWARDED','CANCELLED'));

-- Approval chain decisions (publication gate and request gate; level = 1..N of the template chain).
CREATE TABLE approvals (
  id            uuid PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants(id),
  subject_type  text NOT NULL CHECK (subject_type IN ('TENDER','REQUEST')),
  subject_id    uuid NOT NULL,
  gate          text NOT NULL,
  level         integer NOT NULL,
  role          text NOT NULL,
  approver_id   uuid NOT NULL,
  decision      text NOT NULL CHECK (decision IN ('APPROVED','RETURNED','REJECTED')),
  reason        text,
  round         integer NOT NULL DEFAULT 1,
  decided_at    timestamptz NOT NULL
);
CREATE INDEX approvals_subject_idx ON approvals (tenant_id, subject_id);

-- Ministry of Commerce activity codes and vendor grades (1 = First grade … 3 = Third grade).
CREATE TABLE activity_codes (
  tenant_id text NOT NULL REFERENCES tenants(id),
  code      text NOT NULL,
  name_en   text NOT NULL,
  name_ar   text NOT NULL,
  PRIMARY KEY (tenant_id, code)
);
CREATE TABLE vendor_classifications (
  tenant_id     text NOT NULL REFERENCES tenants(id),
  vendor_id     uuid NOT NULL REFERENCES vendors(id),
  activity_code text NOT NULL,
  grade         integer NOT NULL CHECK (grade BETWEEN 1 AND 3),
  valid_until   date,
  updated_by    text,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vendor_id, activity_code)
);

-- Departmental procurement requests (BRD: Raslni or scanned GM letter, scan mandatory).
CREATE TABLE procurement_requests (
  id                 uuid PRIMARY KEY,
  tenant_id          text NOT NULL REFERENCES tenants(id),
  request_number     text NOT NULL,
  department         text NOT NULL,
  subject            text NOT NULL,
  description        text NOT NULL DEFAULT '',
  source             text NOT NULL CHECK (source IN ('RASLNI','LETTER')),
  source_reference   text,
  estimated_budget   numeric,
  letter_document_id uuid,
  suggested_template text,
  status             text NOT NULL DEFAULT 'SUBMITTED' CHECK (status IN ('SUBMITTED','IN_APPROVAL','APPROVED','REJECTED','CONVERTED')),
  tender_id          uuid,
  created_by         uuid NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, request_number)
);

-- Publication channels (portal, Kuwait Al-Youm official gazette, CAPT).
CREATE TABLE publications (
  id           uuid PRIMARY KEY,
  tenant_id    text NOT NULL REFERENCES tenants(id),
  tender_id    uuid NOT NULL REFERENCES tenders(id),
  channel      text NOT NULL CHECK (channel IN ('PORTAL','KUWAIT_ALYOUM','CAPT')),
  status       text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','APPROVED','PUBLISHED')),
  notice_en    text NOT NULL DEFAULT '',
  notice_ar    text NOT NULL DEFAULT '',
  reference    text,
  published_on date,
  ai_run_id    uuid,
  document_id  uuid,
  created_by   uuid NOT NULL,
  approved_by  uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tender_id, channel)
);

-- Two-envelope opening: technical pass/fail and the financial opening per bid.
ALTER TABLE bids ADD COLUMN technical_result text CHECK (technical_result IN ('PASSED','FAILED'));
ALTER TABLE bids ADD COLUMN technical_score numeric;
ALTER TABLE bids ADD COLUMN financial_opened_at timestamptz;

-- Documents: versions (addenda supersede pack files), records lock, repository metadata.
ALTER TABLE documents ADD COLUMN supersedes_id uuid;
ALTER TABLE documents ADD COLUMN version_no integer NOT NULL DEFAULT 1;
ALTER TABLE documents ADD COLUMN is_record boolean NOT NULL DEFAULT false;
ALTER TABLE documents ADD COLUMN record_declared_at timestamptz;
ALTER TABLE documents ADD COLUMN store_meta jsonb NOT NULL DEFAULT '{}';
ALTER TABLE documents DROP CONSTRAINT documents_owner_type_check;
ALTER TABLE documents ADD CONSTRAINT documents_owner_type_check
  CHECK (owner_type IN ('VENDOR','TENDER_PACK','ADDENDUM','BID_TECHNICAL','BID_FINANCIAL','OPENING_RECORD','COMMITTEE_REPORT',
                        'REQUEST_LETTER','NOTICE','EVALUATION_NARRATIVE'));

-- AI runs: new advisory kinds; tender_id stays nullable (request intake, vendor relevance, chat).
ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_kind_check;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_kind_check
  CHECK (kind IN ('PACK_CHECK','CLARIFICATION_DRAFT','COMPLIANCE_SCREEN','REQUEST_CLASSIFY','RELEVANCE_MATCH',
                  'GAZETTE_NOTICE','EVALUATION_NARRATIVE','GRADE_REVIEW','ASSISTANT_CHAT'));
ALTER TABLE ai_runs ADD COLUMN subject_id uuid;

-- In-app notifications (relevance alerts, approvals waiting).
CREATE TABLE notifications (
  id          uuid PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants(id),
  user_id     uuid,
  vendor_id   uuid,
  kind        text NOT NULL,
  title_en    text NOT NULL,
  title_ar    text NOT NULL,
  body        jsonb NOT NULL DEFAULT '{}',
  read_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (tenant_id, user_id);
CREATE INDEX notifications_vendor_idx ON notifications (tenant_id, vendor_id);

-- Tender document purchase (BRD: KNET with server-side verification; TEST gateway until a KNET merchant exists).
CREATE TABLE tender_purchases (
  id             uuid PRIMARY KEY,
  tenant_id      text NOT NULL REFERENCES tenants(id),
  tender_id      uuid NOT NULL REFERENCES tenders(id),
  vendor_id      uuid NOT NULL REFERENCES vendors(id),
  amount         numeric NOT NULL,
  currency       text NOT NULL,
  gateway        text NOT NULL CHECK (gateway IN ('TEST','KNET','EXEMPT')),
  payment_ref    text,
  receipt_number text NOT NULL,
  status         text NOT NULL CHECK (status IN ('PAID','EXEMPTED')),
  paid_by        uuid,
  paid_at        timestamptz NOT NULL,
  UNIQUE (tender_id, vendor_id),
  UNIQUE (tenant_id, receipt_number)
);
