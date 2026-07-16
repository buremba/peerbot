-- migrate:up

-- An identity's connector key identifies the integration type, not the exact
-- installed account that asserted it. Keep that durable provenance on the
-- identity claim so merge reviewers can inspect the source connection.
--
-- Metadata-only (transaction-safe): a nullable column add plus a NOT VALID FK.
-- The referencing-side index is built CONCURRENTLY in the follow-on
-- transaction:false migration (a CONCURRENTLY build can't run in a transaction).

-- Nullable column add is metadata-only (no table rewrite / no default backfill).
ALTER TABLE public.entity_identities
  ADD COLUMN IF NOT EXISTS connection_id bigint;

-- FK added NOT VALID: skips the validating full-table scan + the SHARE ROW
-- EXCLUSIVE lock on both tables at add time. The column was just introduced, so
-- there are no pre-existing non-null values to validate — no VALIDATE pass is
-- needed and none is emitted. The constraint still fully enforces every future
-- write. Guarded by pg_constraint so a re-run is a no-op.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'entity_identities_connection_id_fkey'
      AND conrelid = 'public.entity_identities'::regclass
  ) THEN
    ALTER TABLE public.entity_identities
      ADD CONSTRAINT entity_identities_connection_id_fkey
      FOREIGN KEY (connection_id) REFERENCES public.connections(id) ON DELETE SET NULL NOT VALID;
  END IF;
END $$;

-- migrate:down

ALTER TABLE public.entity_identities DROP CONSTRAINT IF EXISTS entity_identities_connection_id_fkey;
ALTER TABLE public.entity_identities DROP COLUMN IF EXISTS connection_id;
