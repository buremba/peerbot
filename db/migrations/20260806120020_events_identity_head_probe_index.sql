-- migrate:up transaction:false

-- Stable THING-identity for event rows (schema part 3: the probe index).
-- Companion to 20260806120010, in its own file for the same reason: CREATE
-- INDEX CONCURRENTLY cannot share a transaction, and dbmate sends a
-- transaction:false block as one simple-query batch.
--
-- The root index (20260806120010) is the CONSTRAINT; it cannot also serve the
-- head PROBE. `findCurrentHeadByIdentity` looks up the live head — `WHERE
-- organization_id = $1 AND identity_ns = 'behavior_event' AND identity_key =
-- $2 AND superseded_by IS NULL` — and a partial index is usable only when the
-- query implies its predicate. The probe's `superseded_by IS NULL` does not
-- imply the root index's `supersedes_event_id IS NULL` (a chain's head is
-- usually NOT its root), so without this index the planner falls back to
-- idx_events_live_org_created and FILTERS the org's whole live set per probe —
-- the same O(org history) shape as the `metadata @>` probe this branch removes
-- (measured 970 ms at prod scale), and worst exactly on the common no-head
-- first-run path, which scans everything before concluding nothing matches.
--
-- Non-unique on purpose. insertEvent inserts the successor before stamping the
-- predecessor's superseded_by, so both rows are briefly live inside that
-- transaction and a UNIQUE live-head index would reject every ordinary
-- supersede (why the constraint keys the ROOT instead). As a plain probe index
-- the transient second entry is harmless, and the stamp removes the replaced
-- row from the index automatically.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_identity_head_behavior
  ON public.events (organization_id, identity_key)
  WHERE superseded_by IS NULL
    AND identity_key IS NOT NULL
    AND identity_ns = 'behavior_event';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_identity_head_behavior;
