-- migrate:up

-- Correction-events (P1): watcher_window_field_feedback is fully retired — all reads AND writes now
-- use the events spine (semantic_type='correction'). This migration ships COLLAPSED (expand +
-- read/write flip + drop in one release / flag-day), so the historic backfill that the staged
-- rollout ran out-of-band (scripts/backfill-feedback-corrections.sh) is folded inline BELOW —
-- existing feedback is mirrored into correction events before the table is dropped, so no history
-- is lost. (Multi-replica note: feedback submit/get is a rare human op; old pods may briefly 500 on
-- it during the rolling deploy until replaced — accepted, same flag-day tradeoff as the P4 drop.)

-- Keep the id sequence ALIVE past the table: the write path still allocates 'wwff_<seq>' ids.
ALTER SEQUENCE public.watcher_window_field_feedback_id_seq OWNED BY NONE;

-- Fold the historic backfill inline (table is human-scale, not events-scale → safe in-migration).
-- Idempotent via origin_id; created_by FK-safe-resolved (NULL if not a live user), matching the
-- trigger. Mirrors every not-yet-mirrored feedback row into a 'correction' event before the drop.
INSERT INTO public.events
  (organization_id, semantic_type, entity_ids, origin_id, metadata, created_by, occurred_at, created_at)
SELECT
  f.organization_id, 'correction', '{}'::bigint[], 'wwff_' || f.id::text,
  jsonb_build_object(
    'window_id', f.window_id, 'watcher_id', f.watcher_id, 'field_path', f.field_path,
    'mutation', f.mutation, 'corrected_value', f.corrected_value, 'note', f.note),
  (SELECT u.id FROM public."user" u WHERE u.id = f.created_by),
  f.created_at, f.created_at
FROM public.watcher_window_field_feedback f
WHERE NOT EXISTS (
  SELECT 1 FROM public.events e
  WHERE e.origin_id = 'wwff_' || f.id::text AND e.semantic_type = 'correction'
);

DROP TRIGGER IF EXISTS trg_mirror_feedback_correction ON public.watcher_window_field_feedback;
DROP FUNCTION IF EXISTS public.mirror_feedback_correction();

-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.watcher_window_field_feedback;

-- migrate:down

-- Restore the table structure + sequence ownership + the mirror trigger. NOTE: the correction
-- DATA lives in events (semantic_type='correction') and is NOT moved back by this down.
CREATE TABLE IF NOT EXISTS public.watcher_window_field_feedback (
  id bigint PRIMARY KEY DEFAULT nextval('public.watcher_window_field_feedback_id_seq'),
  -- squawk-ignore prefer-bigint-over-int -- restores the original integer FK columns (referencing integer PKs)
  window_id integer NOT NULL REFERENCES public.watcher_windows(id) ON DELETE CASCADE,
  -- squawk-ignore prefer-bigint-over-int -- restores the original integer FK columns (referencing integer PKs)
  watcher_id integer NOT NULL REFERENCES public.watchers(id) ON DELETE CASCADE,
  organization_id text NOT NULL,
  field_path text NOT NULL,
  mutation text NOT NULL DEFAULT 'set',
  corrected_value jsonb,
  note text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT watcher_window_field_feedback_mutation_check
    CHECK (mutation IN ('set', 'remove', 'add'))
);
ALTER SEQUENCE public.watcher_window_field_feedback_id_seq
  OWNED BY public.watcher_window_field_feedback.id;

CREATE OR REPLACE FUNCTION public.mirror_feedback_correction() RETURNS trigger AS $$
BEGIN
  INSERT INTO public.events
    (organization_id, semantic_type, entity_ids, origin_id, metadata, created_by, occurred_at, created_at)
  VALUES (
    NEW.organization_id, 'correction', '{}'::bigint[], 'wwff_' || NEW.id::text,
    jsonb_build_object('window_id', NEW.window_id, 'watcher_id', NEW.watcher_id,
      'field_path', NEW.field_path, 'mutation', NEW.mutation,
      'corrected_value', NEW.corrected_value, 'note', NEW.note),
    (SELECT u.id FROM public."user" u WHERE u.id = NEW.created_by),
    NEW.created_at, NEW.created_at
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_mirror_feedback_correction
  AFTER INSERT ON public.watcher_window_field_feedback
  FOR EACH ROW EXECUTE FUNCTION public.mirror_feedback_correction();
