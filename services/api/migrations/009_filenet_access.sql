-- TenderFlow — FileNet workstream: repository security state.
-- The permission-list state of each FileNet document (FILENET_ACL_MODE=groups) is kept in documents.store_meta->'acl'
-- ({level, appliedLevel, status PENDING|APPLIED|FAILED|UNVERIFIED|INHERITED, attempts, grantees, error, at}); the
-- scheduler job filenet-access-retry looks for the documents whose change is still pending or failed. This partial
-- index keeps that lookup cheap; no data is changed.
CREATE INDEX IF NOT EXISTS documents_filenet_acl_status_idx
  ON documents ((store_meta->'acl'->>'status'))
  WHERE store_type = 'filenet' AND store_meta ? 'acl';
