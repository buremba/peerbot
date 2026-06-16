-- migrate:up transaction:false

-- DB hygiene pass (audit 2026-06-16).
--
-- (1) Three foreign-key columns had no supporting index. Postgres does NOT
--     auto-index the referencing side of an FK, so every DELETE on the parent
--     does a sequential scan of the child to enforce the constraint, and the
--     child stays locked for the duration. `runs` is the one that matters
--     (112 MB / ~157k rows): deleting a `watcher_windows` row seq-scans it.
-- (2) `oauth_tokens_token_hash_idx` (plain btree on token_hash) fully overlaps
--     `oauth_tokens_token_hash_key` (UNIQUE btree on the same column) — a pure
--     duplicate. Drop the redundant non-unique copy; the unique index serves
--     every lookup it served.
--
-- All four are single-column btrees. CONCURRENTLY (transaction:false) so the
-- pre-upgrade Helm hook never blocks writes: runs ~ a few seconds across two
-- passes, oauth_tokens (10 MB / ~12k rows) sub-second. CONCURRENTLY+IF NOT
-- EXISTS can leave an invalid index on mid-build failure — see
-- docs/MIGRATIONS.md for the recovery recipe.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_runs_window_id
    ON public.runs (window_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS oauth_tokens_parent_token_id_idx
    ON public.oauth_tokens (parent_token_id);

CREATE INDEX CONCURRENTLY IF NOT EXISTS oauth_tokens_organization_id_idx
    ON public.oauth_tokens (organization_id);

DROP INDEX CONCURRENTLY IF EXISTS public.oauth_tokens_token_hash_idx;

-- migrate:down transaction:false

CREATE INDEX CONCURRENTLY IF NOT EXISTS oauth_tokens_token_hash_idx
    ON public.oauth_tokens (token_hash);

DROP INDEX CONCURRENTLY IF EXISTS public.oauth_tokens_organization_id_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.oauth_tokens_parent_token_id_idx;
DROP INDEX CONCURRENTLY IF EXISTS public.idx_runs_window_id;
