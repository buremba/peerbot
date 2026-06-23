-- migrate:up

-- Correction-events consolidation (P1) phase 1 (expand): mirror watcher_window_field_feedback
-- (append-only window-field corrections) into the events spine as semantic_type='correction'
-- (the single edit model). A trigger mirrors new feedback rows; historic rows backfill OUT OF
-- BAND (scripts/backfill-feedback-corrections.sh). Additive — nothing reads the correction
-- events yet (feedback reads still use watcher_window_field_feedback; flip in phase 2).
--
-- Pollution-safe (Spike F lesson): entity_ids=[] + NO payload_text + semantic_type='correction'
-- keep these OUT of content/search/embedding consumers.
-- FK-safe: created_by is resolved to NULL if it isn't a valid user, so the mirror can NEVER
-- break a feedback submit on the events_created_by_fkey (feedback already requires a user, but
-- this is belt-and-suspenders for backfilled/edge rows).
-- O(1) at deploy: trigger create only; the (events-spine) backfill is out-of-band batched.

CREATE OR REPLACE FUNCTION public.mirror_feedback_correction() RETURNS trigger AS $$
BEGIN
  INSERT INTO public.events
    (organization_id, semantic_type, entity_ids, origin_id, metadata, created_by, occurred_at, created_at)
  VALUES (
    NEW.organization_id,
    'correction',
    '{}'::bigint[],
    'wwff_' || NEW.id::text,
    jsonb_build_object(
      'window_id', NEW.window_id,
      'watcher_id', NEW.watcher_id,
      'field_path', NEW.field_path,
      'mutation', NEW.mutation,
      'corrected_value', NEW.corrected_value,
      'note', NEW.note
    ),
    (SELECT u.id FROM public."user" u WHERE u.id = NEW.created_by),
    NEW.created_at,
    NEW.created_at
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_mirror_feedback_correction
  AFTER INSERT ON public.watcher_window_field_feedback
  FOR EACH ROW EXECUTE FUNCTION public.mirror_feedback_correction();

-- migrate:down

-- events is APPEND-ONLY (never DELETE FROM events). The down removes only the trigger +
-- function; the mirrored 'correction' events remain (harmless — pre-P1 readers don't read
-- semantic_type='correction'). Tombstone semantics, per the append-only invariant.
DROP TRIGGER IF EXISTS trg_mirror_feedback_correction ON public.watcher_window_field_feedback;
DROP FUNCTION IF EXISTS public.mirror_feedback_correction();
