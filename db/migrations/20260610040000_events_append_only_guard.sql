-- migrate:up

-- Enforce the append-only invariant on `events` at the database layer.
--
-- AGENTS.md: "events is append-only. Never DELETE FROM events; tombstone via
-- supersedes_event_id." Until now that was convention + a COMMENT ON TABLE —
-- nothing stopped a raw DELETE from any code path, psql session, or admin
-- tool. This trigger makes the invariant airtight while preserving the two
-- legitimate delete paths:
--
--   1. FK cascades. `events_organization_id_fkey` is ON DELETE CASCADE, so an
--      organization hard-delete must still sweep its events. Cascaded deletes
--      execute nested inside the RI system trigger, where pg_trigger_depth()
--      is > 1; a direct top-level DELETE fires this trigger at depth 1.
--
--   2. Sanctioned maintenance (e.g. scripts/cleanup-google-photos.sql, e2e
--      teardown). Opt in per-transaction:
--        BEGIN;
--        SET LOCAL lobu.allow_event_delete = 'on';
--        DELETE FROM events WHERE ...;
--        COMMIT;
--      SET LOCAL scopes the override to the transaction, so a pooled
--      connection can never leak the bypass to a later query.
--
-- TRUNCATE and DROP TABLE do not fire row-level DELETE triggers, so test
-- teardown that resets the schema is unaffected.

CREATE OR REPLACE FUNCTION public.events_block_direct_delete()
  RETURNS trigger AS $$
BEGIN
  IF pg_trigger_depth() > 1 THEN
    RETURN OLD; -- FK cascade (org delete) or another trigger's cleanup
  END IF;
  IF current_setting('lobu.allow_event_delete', true) = 'on' THEN
    RETURN OLD; -- sanctioned maintenance, transaction-scoped
  END IF;
  RAISE EXCEPTION
    'events is append-only: DELETE of event % blocked. Insert a tombstone (supersedes_event_id) instead, or for sanctioned maintenance run SET LOCAL lobu.allow_event_delete = ''on'' inside the deleting transaction.',
    OLD.id
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_events_append_only ON public.events;
CREATE TRIGGER trg_events_append_only
  BEFORE DELETE ON public.events
  FOR EACH ROW EXECUTE FUNCTION public.events_block_direct_delete();

-- migrate:down

DROP TRIGGER IF EXISTS trg_events_append_only ON public.events;
DROP FUNCTION IF EXISTS public.events_block_direct_delete();
