-- migrate:up transaction:false

-- Replica-race guard for entity-change approval proposals: complete_window can
-- replay the same blocked change concurrently on two pods; the SELECT-then-INSERT
-- dedupe in proposeEntityChange can then double-insert. A byte-identical pending
-- proposal collides here and the loser resolves to the winner's run.
--
-- CONCURRENTLY (transaction:false, one statement): `runs` is a hot table; a
-- plain CREATE INDEX would block writes for the build. The partial predicate
-- matches only pending internal entity-change runs, so the build scans a tiny
-- match set.
CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS runs_entity_change_pending_dedupe
  ON public.runs (organization_id, action_key, md5(action_input::text))
  WHERE run_type = 'internal'
    AND action_key IN ('entity_field_change', 'entity_change')
    AND approval_status = 'pending'
    AND status = 'pending';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.runs_entity_change_pending_dedupe;
