-- TenderFlow — Insight workstream: auditor evidence packs are stored as documents (owner_type EVIDENCE_PACK) so the
-- ZIP lands in the content store (IBM FileNet in production) next to the tender it covers. Dashboards, analytics and
-- the public tender board are queries over existing tables and need no schema.
--
-- The owner_type CHECK constraint is extended in place: whatever list earlier migrations (including other workstreams'
-- 004–006) left in it is kept, and 'EVIDENCE_PACK' is added.
DO $$
DECLARE
  def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO def
    FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
   WHERE t.relname = 'documents' AND c.conname = 'documents_owner_type_check';
  IF def IS NULL THEN
    RETURN; -- no constraint: nothing to extend
  END IF;
  IF position('''EVIDENCE_PACK''' IN def) > 0 THEN
    RETURN; -- already allowed
  END IF;
  IF position('ARRAY[' IN def) = 0 THEN
    RAISE EXCEPTION 'unexpected documents_owner_type_check definition: %', def;
  END IF;
  EXECUTE 'ALTER TABLE documents DROP CONSTRAINT documents_owner_type_check';
  EXECUTE 'ALTER TABLE documents ADD CONSTRAINT documents_owner_type_check '
          || replace(def, 'ARRAY[', 'ARRAY[''EVIDENCE_PACK''::text, ');
END $$;

CREATE INDEX IF NOT EXISTS documents_owner_type_idx ON documents (tenant_id, owner_type);
