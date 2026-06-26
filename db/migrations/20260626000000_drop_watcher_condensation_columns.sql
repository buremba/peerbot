-- migrate:up

-- Contract phase of the watcher condensation/rollup removal.
--
-- The columns were made dead in the prior release (#1575, "remove dead
-- condensation/rollup feature — expand phase"): no code across server,
-- agent-worker, cli, or the owletto frontend reads or writes any of them, and
-- they are NOT in the query_sql table-schema allowlist
-- (packages/server/src/utils/table-schema.ts) — so no scoped CTE emits them.
--
-- MUST ship in a release AFTER #1575 is fully deployed to every replica. Until
-- then an old pod still runs pre-#1575 code; dropping the columns mid-rollout
-- would break it. Once #1575 is live, no running replica references any of
-- these, so the drop is safe under a rolling upgrade. DROP COLUMN is an O(1)
-- catalog flip under a brief ACCESS EXCLUSIVE lock — no table rewrite.

-- Dead rollup artifacts (is_rollup = true) were never period-unique against leaf
-- rows (the old index below only constrained is_rollup = false). Remove them
-- BEFORE recreating the index without that predicate, otherwise a former rollup
-- row could collide with a leaf row on (watcher_id, window_start, window_end).
DELETE FROM public.watcher_windows WHERE is_rollup = true;

-- Dropping is_rollup auto-drops the partial unique index
-- idx_watcher_windows_unique_period (its predicate references the column).
ALTER TABLE public.watcher_windows DROP COLUMN IF EXISTS is_rollup;
ALTER TABLE public.watcher_windows DROP COLUMN IF EXISTS source_window_ids;
ALTER TABLE public.watcher_windows DROP COLUMN IF EXISTS depth;

ALTER TABLE public.watcher_versions DROP COLUMN IF EXISTS condensation_prompt;
ALTER TABLE public.watcher_versions DROP COLUMN IF EXISTS condensation_window_count;

-- Recreate the period-uniqueness index without the now-removed `is_rollup`
-- predicate (it is always-true post-removal, so a plain unique index is the
-- equivalent constraint). complete-window.ts relies on the 23505 it raises to
-- guard concurrent window creation. The brief ACCESS EXCLUSIVE lock during the
-- build is acceptable in the deploy hook at this table's size; CONCURRENTLY
-- cannot run inside dbmate's migration transaction.
-- squawk-ignore prefer-robust-stmts,require-concurrent-index-creation
CREATE UNIQUE INDEX idx_watcher_windows_unique_period
  ON public.watcher_windows USING btree (watcher_id, window_start, window_end);

-- migrate:down
-- Rollback-only path (dev). The integer column types and the brief DROP INDEX
-- lock below intentionally restore the ORIGINAL baseline schema; the per-
-- statement lint directives reflect that.

-- squawk-ignore require-concurrent-index-deletion -- dev rollback; brief lock is fine
DROP INDEX IF EXISTS idx_watcher_windows_unique_period;

-- squawk-ignore prefer-bigint-over-int -- restores original integer column
ALTER TABLE public.watcher_versions ADD COLUMN IF NOT EXISTS condensation_window_count integer DEFAULT 4;
ALTER TABLE public.watcher_versions ADD COLUMN IF NOT EXISTS condensation_prompt text;

-- squawk-ignore prefer-bigint-over-int -- restores original integer column
ALTER TABLE public.watcher_windows ADD COLUMN IF NOT EXISTS depth integer DEFAULT 0;
-- squawk-ignore prefer-bigint-over-int -- restores original integer[] column
ALTER TABLE public.watcher_windows ADD COLUMN IF NOT EXISTS source_window_ids integer[];
ALTER TABLE public.watcher_windows ADD COLUMN IF NOT EXISTS is_rollup boolean DEFAULT false;

-- Restore the original partial unique index (deleted rollup rows are not
-- restored — down is a schema rollback only).
-- squawk-ignore prefer-robust-stmts,require-concurrent-index-creation
CREATE UNIQUE INDEX idx_watcher_windows_unique_period
  ON public.watcher_windows USING btree (watcher_id, window_start, window_end)
  WHERE (is_rollup = false);
