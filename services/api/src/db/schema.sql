-- =========================================================
-- KBM TenderFlow v0.9.0 - PostgreSQL 16 Relational Schema
-- =========================================================
-- Non-negotiable rule: NEVER store document bodies in PostgreSQL.
-- Document contents are stored in Content Adapter (FileNet / FileSystem).

CREATE TABLE IF NOT EXISTS tenants (
    id VARCHAR(64) PRIMARY KEY,
    name_en VARCHAR(255) NOT NULL,
    name_ar VARCHAR(255) NOT NULL,
    default_currency VARCHAR(10) NOT NULL DEFAULT 'KWD',
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    branding JSONB NOT NULL DEFAULT '{}'::jsonb,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    username VARCHAR(128) NOT NULL,
    email VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    role VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'ACTIVE',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_tenant_username UNIQUE (tenant_id, username)
);

CREATE TABLE IF NOT EXISTS vendors (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    legal_name_en VARCHAR(255) NOT NULL,
    legal_name_ar VARCHAR(255) NOT NULL,
    cr_number VARCHAR(128) NOT NULL,
    contact_email VARCHAR(255) NOT NULL,
    contact_phone VARCHAR(64),
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING_REVIEW',
    document_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_tenant_cr_number UNIQUE (tenant_id, cr_number)
);

CREATE TABLE IF NOT EXISTS tenders (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tender_number VARCHAR(128) NOT NULL,
    title_en VARCHAR(255) NOT NULL,
    title_ar VARCHAR(255) NOT NULL,
    category VARCHAR(64) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
    estimated_budget NUMERIC(15, 3) NOT NULL,
    currency VARCHAR(10) NOT NULL DEFAULT 'KWD',
    submission_deadline TIMESTAMPTZ NOT NULL,
    document_ids TEXT[] DEFAULT ARRAY[]::TEXT[],
    awarded_vendor_id VARCHAR(64) REFERENCES vendors(id),
    ai_advisory_ref VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_tenant_tender_number UNIQUE (tenant_id, tender_number)
);

CREATE TABLE IF NOT EXISTS clarifications (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tender_id VARCHAR(64) NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
    vendor_id VARCHAR(64) REFERENCES vendors(id),
    question TEXT NOT NULL,
    answer TEXT,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    answered_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS addenda (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tender_id VARCHAR(64) NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
    addendum_number INT NOT NULL,
    title VARCHAR(255) NOT NULL,
    content TEXT NOT NULL,
    document_id VARCHAR(64),
    issued_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_tender_addendum_no UNIQUE (tender_id, addendum_number)
);

-- Sealed Bids: Payload doc IDs remain cryptographically locked until unsealing event
CREATE TABLE IF NOT EXISTS bids (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tender_id VARCHAR(64) NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
    vendor_id VARCHAR(64) NOT NULL REFERENCES vendors(id),
    vendor_name VARCHAR(255) NOT NULL,
    status VARCHAR(32) NOT NULL DEFAULT 'SEALED',
    hash_digest VARCHAR(128) NOT NULL,
    technical_doc_id VARCHAR(64) NOT NULL,
    financial_doc_id VARCHAR(64) NOT NULL,
    envelope_key_encrypted TEXT NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    unsealed_at TIMESTAMPTZ,
    CONSTRAINT uq_tender_vendor_bid UNIQUE (tender_id, vendor_id)
);

CREATE TABLE IF NOT EXISTS bid_opening_ceremonies (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tender_id VARCHAR(64) NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
    ceremony_time TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    committee_chair VARCHAR(255) NOT NULL,
    attendees TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    minutes_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_tender_opening UNIQUE (tender_id)
);

CREATE TABLE IF NOT EXISTS evaluations (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tender_id VARCHAR(64) NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
    bid_id VARCHAR(64) NOT NULL REFERENCES bids(id) ON DELETE CASCADE,
    evaluator_id VARCHAR(128) NOT NULL,
    technical_score NUMERIC(5, 2) NOT NULL,
    financial_score NUMERIC(5, 2) NOT NULL,
    composite_score NUMERIC(5, 2) NOT NULL,
    comments TEXT,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_bid_evaluator UNIQUE (bid_id, evaluator_id)
);

CREATE TABLE IF NOT EXISTS awards (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    tender_id VARCHAR(64) NOT NULL REFERENCES tenders(id) ON DELETE CASCADE,
    winning_vendor_id VARCHAR(64) NOT NULL REFERENCES vendors(id),
    award_value NUMERIC(15, 3) NOT NULL,
    justification TEXT NOT NULL,
    approved_by VARCHAR(255) NOT NULL,
    awarded_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT uq_tender_award UNIQUE (tender_id)
);

-- Immutable, Tamper-Evident Audit Ledger (Rule 2)
CREATE TABLE IF NOT EXISTS audit_logs (
    id VARCHAR(64) PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    actor_id VARCHAR(255) NOT NULL,
    actor_role VARCHAR(64) NOT NULL DEFAULT 'SYSTEM',
    action VARCHAR(128) NOT NULL,
    resource_type VARCHAR(64) NOT NULL,
    resource_id VARCHAR(64) NOT NULL,
    prev_state VARCHAR(64),
    new_state VARCHAR(64),
    reason TEXT,
    ip_address VARCHAR(45),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    prev_signature VARCHAR(128),
    hmac_signature VARCHAR(128) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_tenant_resource ON audit_logs (tenant_id, resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_logs (timestamp);
