-- migrate:up transaction:false

-- Widen the events interaction CHECK constraints to admit the non-blocking
-- "suggested actions" interaction type. Suggestions are agent-emitted chips
-- the user MAY tap to send a message as a new turn.
-- They are a first-class interaction type on the same durable-event substrate
-- as `approval` cards (persisted, replayed on reload, superseded each turn),
-- but non-blocking: they are never resolved by a click. A later successful
-- turn supersedes or clears them, so their live status is 'current' rather
-- than the approval lifecycle 'pending' -> approved/rejected.
--
-- Replace each constraint atomically, then validate it separately. Adding the
-- replacement as NOT VALID avoids scanning events while holding the
-- ACCESS EXCLUSIVE lock needed by ALTER TABLE; VALIDATE performs the scan
-- under a weaker lock. Existing rows already satisfy the wider predicates.
-- Safe under a rolling deploy: old pods only write the pre-existing values,
-- which remain legal.

-- interaction_type: allow 'suggestion' alongside 'none' | 'approval'.
ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_interaction_type_check,
  ADD CONSTRAINT events_interaction_type_check CHECK (
    interaction_type = ANY (ARRAY[
      'none'::text, 'approval'::text, 'suggestion'::text
    ])
  ) NOT VALID;
ALTER TABLE public.events
  VALIDATE CONSTRAINT events_interaction_type_check;

-- interaction_status: allow 'current' (the live-suggestion marker) alongside
-- the approval lifecycle statuses.
ALTER TABLE public.events
  DROP CONSTRAINT IF EXISTS events_interaction_status_check,
  ADD CONSTRAINT events_interaction_status_check CHECK (
    interaction_status = ANY (ARRAY[
      'pending'::text, 'approved'::text, 'rejected'::text,
      'completed'::text, 'failed'::text, 'current'::text
    ])
  ) NOT VALID;
ALTER TABLE public.events
  VALIDATE CONSTRAINT events_interaction_status_check;

-- API/Builder conversations have no numeric connection_id, so the existing
-- (connection_id, origin_id) index cannot serve suggestion lookups.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_events_current_suggestion_origin
  ON public.events (organization_id, origin_id)
  WHERE superseded_by IS NULL
    AND interaction_type = 'suggestion'
    AND interaction_status = 'current';

-- migrate:down transaction:false

-- Refuse to narrow the constraints while suggestion rows remain. The check
-- and both replacements run in one transaction so a failed rollback leaves
-- the wider constraints intact.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.events
    WHERE interaction_type = 'suggestion'
       OR interaction_status = 'current'
  ) THEN
    RAISE EXCEPTION
      'Cannot roll back suggestion constraints while suggestion events remain';
  END IF;

  ALTER TABLE public.events
    DROP CONSTRAINT IF EXISTS events_interaction_type_check,
    ADD CONSTRAINT events_interaction_type_check CHECK (
      interaction_type = ANY (ARRAY['none'::text, 'approval'::text])
    );

  ALTER TABLE public.events
    DROP CONSTRAINT IF EXISTS events_interaction_status_check,
    ADD CONSTRAINT events_interaction_status_check CHECK (
      interaction_status = ANY (ARRAY[
        'pending'::text, 'approved'::text, 'rejected'::text,
        'completed'::text, 'failed'::text
      ])
    );
END
$$;

DROP INDEX CONCURRENTLY IF EXISTS public.idx_events_current_suggestion_origin;
