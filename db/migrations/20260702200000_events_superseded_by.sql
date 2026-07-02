-- migrate:up

-- Denormalize supersession lineage onto the row it supersedes.
--
-- Background: `events` is append-only. An edit/delete inserts a NEW row whose
-- `supersedes_event_id` points back at the row it replaces. The masking view
-- `current_event_records` today hides replaced rows with a per-row anti-join:
--   WHERE NOT EXISTS (SELECT 1 FROM events newer WHERE newer.supersedes_event_id = e.id)
-- In prod ~75% of rows are superseded, so every live-row read scans mostly-dead
-- rows. This column lets the view flip to a cheap `WHERE superseded_by IS NULL`
-- predicate backed by a partial index — but ONLY after the backfill lands
-- (see Stage 2 below).
--
-- `superseded_by` holds the id of the row that superseded THIS row (the inverse
-- edge of `supersedes_event_id`). It is lineage metadata, NOT payload — the
-- append-only invariant applies to content, and precedent for post-insert
-- lineage maintenance is `search_tsv`. There is at most one superseder per row
-- (enforced by the partial unique index `idx_events_superseded_by` on
-- `supersedes_event_id`), so this is a 1:1 inverse.
--
-- Stage 1 (THIS migration): add the column only. No DEFAULT, no NOT NULL, no
-- FK, no index — a pure catalog change that does NOT rewrite the 2M+ row heap
-- and does not block writes. A prior inline 1.5M-row UPDATE inside a migration
-- caused an outage; the historical backfill is deliberately a separate,
-- batched, out-of-band script (scripts/backfill-superseded-by.ts). New
-- superseding writes dual-write this column in the same transaction as the
-- superseding INSERT (packages/server/src/utils/insert-event.ts).
--
-- Stage 2 (SEPARATE, LATER — NOT in this repo as a migration): once the
-- backfill has completed on prod, deploy the view flip + partial index. It is
-- intentionally NOT committed as a migration file because the migration runner
-- (embedded-runtime.ts / dbmate) auto-applies every unapplied file in filename
-- order at boot, which would flip the view BEFORE the backfill finished and
-- silently un-mask every not-yet-stamped superseded row. The exact Stage 2 SQL
-- is documented in packages/server/src/events/backfill-superseded-by.ts.
ALTER TABLE public.events
    ADD COLUMN IF NOT EXISTS superseded_by bigint;

COMMENT ON COLUMN public.events.superseded_by IS
    'Denormalized inverse of supersedes_event_id: the id of the event that superseded THIS row (NULL = live). Lineage metadata only (never payload). Stamped in the same tx as the superseding INSERT; historical rows filled by scripts/backfill-superseded-by.ts. The current_event_records view flips to WHERE superseded_by IS NULL only after that backfill completes.';

-- migrate:down

ALTER TABLE public.events
    DROP COLUMN IF EXISTS superseded_by;
