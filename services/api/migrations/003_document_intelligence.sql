-- TenderFlow — Document intelligence: every uploaded document can be classified and its key data extracted
-- (with citations) by the watsonx Orchestrate agent tenderflow_document_intelligence; a person reviews the result.
-- FileNet stores the file, Orchestrate understands it, TenderFlow enforces the rules.

-- Per-entity document-type catalogue (what the agent may classify a document as, and which fields it may extract).
-- Defaults are installed per tenant by the API (services/doc-catalogue.ts); TENANT_ADMIN edits them.
-- Personal identity numbers (civil ID etc.) are never catalogue fields.
CREATE TABLE document_types (
  id          uuid PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants(id),
  code        text NOT NULL,
  contexts    text[] NOT NULL DEFAULT '{}',
  name_en     text NOT NULL,
  name_ar     text NOT NULL,
  fields      jsonb NOT NULL DEFAULT '[]',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, code)
);

-- One row per classification run of a document (latest = current). AI values stay as returned; a reviewer's
-- corrections are kept separately (corrected_doc_type / corrected_fields) so both remain visible.
CREATE TABLE document_insights (
  id                 uuid PRIMARY KEY,
  tenant_id          text NOT NULL REFERENCES tenants(id),
  document_id        uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  ai_run_id          uuid,
  status             text NOT NULL CHECK (status IN ('PENDING_REVIEW','ACCEPTED','CORRECTED','REJECTED','NOT_EXTRACTABLE','FAILED')),
  doc_type           text,
  language           text,
  fields             jsonb NOT NULL DEFAULT '[]',
  summary_en         text,
  summary_ar         text,
  citations          jsonb NOT NULL DEFAULT '[]',
  flags              jsonb NOT NULL DEFAULT '[]',
  error              text,
  trigger            text NOT NULL DEFAULT 'MANUAL' CHECK (trigger IN ('MANUAL','UPLOAD','OPENING','FINANCIAL_OPENING')),
  requested_by       uuid,
  corrected_doc_type text,
  corrected_fields   jsonb,
  review_reason      text,
  reviewed_by        uuid,
  reviewed_at        timestamptz,
  filenet            jsonb,
  applied            jsonb NOT NULL DEFAULT '[]',
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX document_insights_doc_idx ON document_insights (tenant_id, document_id, created_at);
CREATE INDEX document_insights_status_idx ON document_insights (tenant_id, status);

ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_kind_check;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_kind_check
  CHECK (kind IN ('PACK_CHECK','CLARIFICATION_DRAFT','COMPLIANCE_SCREEN','REQUEST_CLASSIFY','RELEVANCE_MATCH',
                  'GAZETTE_NOTICE','EVALUATION_NARRATIVE','GRADE_REVIEW','ASSISTANT_CHAT','DOCUMENT_INTELLIGENCE'));
