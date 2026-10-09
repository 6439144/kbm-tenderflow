-- Phase 2 SEC: identity, access and content protection (docs/SECURITY-FEATURES.md).

-- Account administration (FR-035/036) and single sign-on.
ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at   timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_source     text NOT NULL DEFAULT 'LOCAL';  -- LOCAL | OIDC
ALTER TABLE users ADD COLUMN IF NOT EXISTS external_subject text;                          -- OIDC "iss|sub"
ALTER TABLE users ADD COLUMN IF NOT EXISTS disabled_at     timestamptz;
CREATE UNIQUE INDEX IF NOT EXISTS users_external_subject_idx ON users (tenant_id, external_subject) WHERE external_subject IS NOT NULL;

-- Per-entity security policy. One row per tenant (absent row = everything OFF).
CREATE TABLE security_settings (
  tenant_id          text PRIMARY KEY REFERENCES tenants(id),
  mfa_vendors        text NOT NULL DEFAULT 'OFF' CHECK (mfa_vendors IN ('OFF','OPTIONAL','REQUIRED')),
  mfa_staff          text NOT NULL DEFAULT 'OFF' CHECK (mfa_staff IN ('OFF','OPTIONAL','REQUIRED')),
  staff_network      jsonb NOT NULL DEFAULT '{"mode":"OFF","cidrs":[],"trustProxyHeader":false}',
  content_protection text CHECK (content_protection IS NULL OR content_protection IN ('OFF','VIEW_ONLY','WATERMARKED_DOWNLOAD')),
  oidc               jsonb,
  updated_by         text,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- TOTP second factor. The shared secret is AES-256-GCM encrypted; recovery codes are stored as scrypt hashes only.
CREATE TABLE user_mfa (
  user_id         uuid PRIMARY KEY REFERENCES users(id),
  tenant_id       text NOT NULL REFERENCES tenants(id),
  status          text NOT NULL CHECK (status IN ('PENDING','ACTIVE')),
  secret_enc      text NOT NULL,
  recovery_hashes text[] NOT NULL DEFAULT '{}',
  last_used_step  bigint,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  enrolled_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- OIDC authorization-code flow: state/nonce/PKCE verifier between /start and /callback (single use, 10 minutes),
-- and the one-time hand-off from the callback to the single-page app (single use, 60 seconds).
CREATE TABLE oidc_login_states (
  state         text PRIMARY KEY,
  tenant_id     text NOT NULL REFERENCES tenants(id),
  nonce         text NOT NULL,
  code_verifier text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  expires_at    timestamptz NOT NULL
);
CREATE TABLE oidc_handoffs (
  id_hash    text PRIMARY KEY,
  tenant_id  text NOT NULL REFERENCES tenants(id),
  user_id    uuid NOT NULL REFERENCES users(id),
  expires_at timestamptz NOT NULL,
  used_at    timestamptz
);

-- Protected-viewer sessions (one per "View" click): the watermark request id, used to rate-limit deterrent events.
CREATE TABLE content_views (
  id          uuid PRIMARY KEY,
  tenant_id   text NOT NULL REFERENCES tenants(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  user_id     uuid NOT NULL,
  vendor_id   uuid,
  kind        text NOT NULL CHECK (kind IN ('VIEW','DOWNLOAD')),
  events      integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX content_views_doc_idx ON content_views (tenant_id, document_id);
