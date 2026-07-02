-- migrate:up

-- Stage 2 of the superseded_by rollout (Stage 1 = 20260702200000, which added
-- the column + the same-transaction dual-write in insert-event.ts). Fill the
-- denormalized inverse edge for every historical superseded row so the NEXT
-- migration can flip current_event_records to `WHERE superseded_by IS NULL`.
--
-- Inline-UPDATE rationale (vs. the out-of-band-script rule from the classifier
-- backfill outage): the write below is a single set-based UPDATE that our own
-- prod does NOT pay — prod is pre-backfilled out of band via
-- scripts/backfill-superseded-by.ts BEFORE this migration ships, so here it
-- matches ~0 rows. Fresh installs have empty tables. The only installs that pay
-- are self-hosted DBs upgrading with pre-existing superseded rows, which are
-- orders of magnitude below the 1.5M-row scale where an inline UPDATE became an
-- outage. Idempotent: guarded on `superseded_by IS NULL`, and the partial
-- unique index idx_events_superseded_by guarantees at most one superseder per
-- row, so the join is 1:1.
UPDATE events e
SET superseded_by = n.id
FROM events n
WHERE n.supersedes_event_id = e.id
  AND e.superseded_by IS NULL;

-- migrate:down

-- The column stays (Stage 1 owns it); clearing the backfilled values restores
-- the pre-migration state.
UPDATE events SET superseded_by = NULL WHERE superseded_by IS NOT NULL;
