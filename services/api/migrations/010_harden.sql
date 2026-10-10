-- HARDEN workstream: sign-in lockout and single-use grants for the protected document viewer
-- (docs/SECURITY-FEATURES.md §"Sign-in lockout", §"Protected document viewer").

-- Failed password / second-factor attempts per (entity, username). Keyed by the typed username — not by user id —
-- so an unknown username is counted and locked exactly like a real one (no user enumeration). No foreign keys.
CREATE TABLE login_lockouts (
  tenant_id         text NOT NULL,
  username          text NOT NULL,
  failures          integer NOT NULL DEFAULT 0,
  window_started_at timestamptz,
  last_failure_at   timestamptz,
  locked_until      timestamptz,
  lock_count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, username)
);

-- Protected viewer: POST /documents/:id/view-grant issues a random grant (only its SHA-256 is stored), valid 60 s,
-- bound to entity + document + user; GET /documents/:id/view-bytes consumes it once.
CREATE TABLE view_grants (
  id          uuid PRIMARY KEY,
  grant_hash  text NOT NULL UNIQUE,
  tenant_id   text NOT NULL REFERENCES tenants(id),
  document_id uuid NOT NULL REFERENCES documents(id),
  user_id     text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX view_grants_expiry_idx ON view_grants (expires_at);
