-- migrate:up

-- Retire the one-off backfill scratch table from the 2026-05-26 lobucrm org
-- reassignment. It maps event/feed ids to their original org (a rollback net
-- for that migration), has ~155k rows / ~13 MB, no primary key, no indexes, and
-- zero references in code or SQL. The reassignment is long verified in prod
-- (org_lobucrm is active), so the net is no longer needed. Prod-only artifact —
-- never in the baseline, so this is a no-op on fresh DBs via IF EXISTS.

DROP TABLE IF EXISTS public._mig_lobucrm_20260526;

-- migrate:down

-- Reversibility restores the empty shell only; the ~155k rollback-map rows are
-- not recoverable (and aren't needed — the reassignment is verified).
CREATE TABLE IF NOT EXISTS public._mig_lobucrm_20260526 (
    id bigint,
    tbl text,
    orig_org text
);
