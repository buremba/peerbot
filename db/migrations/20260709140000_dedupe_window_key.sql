-- migrate:up transaction:false

-- (sol review #4) Include the run window in the entity-change dedupe identity.
--
-- The batch-approval contract groups a run's proposals by runs.window_id, and
-- window_id rides the COLUMN (not action_input) so the md5(action_input) replay
-- guard stays byte-stable. But that means two DIFFERENT windows that happen to
-- produce a byte-identical proposal collided on the old index and the second
-- window silently reused the first's pending run — its batch card then found
-- nothing to approve. Adding COALESCE(window_id, 0) to the key keeps same-window
-- replica-race dedupe (identical proposal, same window → one run) while making
-- distinct windows distinct. NULL windows collapse to 0 so windowless proposals
-- still dedupe among themselves exactly as before.
--
-- Split across two migrations (create here, drop-old next): a `transaction:false`
-- migration is still sent as ONE simple-query batch, and Postgres wraps a
-- multi-statement batch in an implicit transaction — which CONCURRENTLY forbids.
-- So each CONCURRENTLY statement gets its own single-statement migration. The new
-- index lands BEFORE the old is dropped, so the replica-race guard is never gone.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS runs_entity_change_pending_dedupe_v2
  ON public.runs (
    organization_id,
    action_key,
    COALESCE(window_id, 0),
    md5(action_input::text)
  )
  WHERE run_type = 'internal'
    AND action_key IN ('entity_field_change', 'entity_change')
    AND approval_status = 'pending'
    AND status = 'pending';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.runs_entity_change_pending_dedupe_v2;
