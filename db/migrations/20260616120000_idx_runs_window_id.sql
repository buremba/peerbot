-- migrate:up transaction:false

-- Missing FK index: runs.window_id references watcher_windows(id), but Postgres
-- does not auto-index the referencing side — so deleting a watcher_windows row
-- seq-scans runs and holds it locked. runs is ~112 MB / ~157k rows (over the
-- ~100k CONCURRENTLY threshold in docs/MIGRATIONS.md), so build it CONCURRENTLY
-- to avoid blocking the job queue's writes during the pre-upgrade Helm hook:
-- single-column bigint btree, a few seconds across two passes.
--
-- One statement per transaction:false migration: dbmate sends the whole up
-- block as a single simple-query batch, and Postgres wraps any multi-statement
-- batch in an implicit transaction that CONCURRENTLY refuses to run inside.
-- The CONCURRENTLY + IF NOT EXISTS invalid-index trap recovery is in
-- docs/MIGRATIONS.md.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_window_id
    ON public.runs (window_id);

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.idx_runs_window_id;
