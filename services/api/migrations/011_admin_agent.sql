-- AI admin builder (docs/ADMIN-AI-BUILDER.md): plain-language admin requests turned into structured change proposals by
-- the watsonx Orchestrate agent tenderflow_admin_builder (or submitted by the Orchestrate tool pack). A proposal is
-- validated by TenderFlow's own validators against the entity's current configuration and only ever creates DRAFTS
-- when a TENANT_ADMIN applies it; publishing stays a human step. Strictly per entity (tenant_id on every row).
CREATE TABLE admin_proposals (
  id            uuid PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants(id),
  created_by    text NOT NULL,
  source        text NOT NULL CHECK (source IN ('CHAT','TOOL')),
  thread_id     text,
  ai_run_id     uuid REFERENCES ai_runs(id),
  status        text NOT NULL CHECK (status IN ('PROPOSED','APPLIED','DISCARDED','FAILED')),
  request_text  text NOT NULL,
  operations    jsonb NOT NULL DEFAULT '[]'::jsonb,
  validation    jsonb NOT NULL DEFAULT '{}'::jsonb,
  summary       jsonb NOT NULL DEFAULT '{}'::jsonb,
  messages      jsonb NOT NULL DEFAULT '[]'::jsonb,
  revision      integer NOT NULL DEFAULT 1,
  applied_refs  jsonb,
  applied_by    text,
  applied_at    timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_proposals_tenant_idx ON admin_proposals (tenant_id, created_at DESC);
CREATE INDEX admin_proposals_thread_idx ON admin_proposals (tenant_id, created_by, thread_id);

ALTER TABLE ai_runs DROP CONSTRAINT ai_runs_kind_check;
ALTER TABLE ai_runs ADD CONSTRAINT ai_runs_kind_check
  CHECK (kind IN ('PACK_CHECK','CLARIFICATION_DRAFT','COMPLIANCE_SCREEN','REQUEST_CLASSIFY','RELEVANCE_MATCH',
                  'GAZETTE_NOTICE','EVALUATION_NARRATIVE','GRADE_REVIEW','ASSISTANT_CHAT','DOCUMENT_INTELLIGENCE','ADMIN_BUILDER'));
