-- migrate:up

-- ============================================================================
-- Canvas-on-events Phase 3b: drop the retired watcher_windows table.
--
-- Phase 3a (20260703000000) made canvas_state event chains the sole window
-- storage and deleted every code read/write of watcher_windows, but kept the
-- table so pre-3a pods could keep dual-writing during the rolling deploy. This
-- migration runs in a LATER release, after 3a has fully rolled out (no old pod
-- remains), so:
--   (1) any straggler rows old pods wrote during the 3a overlap are re-keyed
--       and their provenance folded into the run model (verbatim replay of
--       3a's idempotent statements — no-ops when there are no stragglers),
--   (2) the table and the wwff feedback-id sequence are dropped.
--
-- The feedback-id sequence: correction events now use their OWN event id as
-- the feedback id (origin_id NULL); historical 'wwff_<id>' origin_ids remain
-- in the events spine and the reader still parses them.
-- ============================================================================

-- ── (1) Straggler re-key + provenance (idempotent replays of 3a) ────────────

-- (1a) Canvas roots for straggler windows (3a §a.2 — ON CONFLICT no-op).
INSERT INTO public.events (
    entity_ids, organization_id, origin_id, payload_type, payload_data,
    semantic_type, metadata, occurred_at, created_by, created_at
)
SELECT
    CASE WHEN ci.entity_id IS NOT NULL
         THEN ('{' || ci.entity_id || '}')::bigint[]
         ELSE '{}'::bigint[] END,
    w.organization_id,
    'canvas_backfill_' || ww.id,
    'json_template',
    ww.extracted_data,
    'canvas_state',
    jsonb_build_object(
        'watcher_id',      ww.watcher_id,
        'granularity',     ww.granularity,
        'window_start',    to_char(ww.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'window_end',      to_char(ww.window_end   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'content_analyzed', COALESCE(ww.content_analyzed, 0),
        'version_id',      ww.version_id
    ),
    ww.window_end,
    COALESCE(
        w.created_by,
        (
            SELECT m."userId"
            FROM public.member m
            WHERE m."organizationId" = w.organization_id
            ORDER BY CASE m.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END,
                     m."createdAt" ASC
            LIMIT 1
        )
    ),
    COALESCE(ww.created_at, ww.window_end)
FROM public.watcher_windows ww
JOIN public.watchers w ON w.id = ww.watcher_id
LEFT JOIN LATERAL (
    SELECT ei.entity_id
    FROM public.entity_identities ei
    JOIN public.entities e ON e.id = ei.entity_id
    WHERE ei.organization_id = w.organization_id
      AND ei.namespace = 'watcher_canvas'
      AND ei.identifier = w.id::text
      AND ei.deleted_at IS NULL
      AND e.deleted_at IS NULL
    LIMIT 1
) ci ON TRUE
WHERE NOT EXISTS (
    SELECT 1 FROM public.events ev
    WHERE ev.semantic_type = 'canvas_state'
      AND ev.supersedes_event_id IS NULL
      AND (ev.metadata->>'watcher_id')::bigint = ww.watcher_id
      AND (ev.metadata->>'granularity') = ww.granularity
      AND (ev.metadata->>'window_start') =
          to_char(ww.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)
ON CONFLICT (
    ((metadata->>'watcher_id')::bigint),
    (metadata->>'granularity'),
    (metadata->>'window_start')
) WHERE (semantic_type = 'canvas_state' AND supersedes_event_id IS NULL)
DO NOTHING;

-- (1b) Re-key window_id columns still pointing at a live watcher_windows.id
--      (3a §c — only straggler rows match; everything else is already an
--      events id and falls through).
WITH root AS (
    SELECT ww.id AS old_id, ev.id AS root_id
    FROM public.watcher_windows ww
    JOIN public.events ev
      ON ev.semantic_type = 'canvas_state'
     AND ev.supersedes_event_id IS NULL
     AND (ev.metadata->>'watcher_id')::bigint = ww.watcher_id
     AND (ev.metadata->>'granularity') = ww.granularity
     AND (ev.metadata->>'window_start') =
         to_char(ww.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)
UPDATE public.watcher_reactions t SET window_id = r.root_id FROM root r
WHERE t.window_id = r.old_id
  -- collision guard: a window_id that is already a canvas_state event id is
  -- migrated — never rewrite it, even if a straggler ww.id collides numerically.
  AND NOT EXISTS (SELECT 1 FROM public.events g WHERE g.id = t.window_id AND g.semantic_type = 'canvas_state');

WITH root AS (
    SELECT ww.id AS old_id, ev.id AS root_id
    FROM public.watcher_windows ww
    JOIN public.events ev
      ON ev.semantic_type = 'canvas_state'
     AND ev.supersedes_event_id IS NULL
     AND (ev.metadata->>'watcher_id')::bigint = ww.watcher_id
     AND (ev.metadata->>'granularity') = ww.granularity
     AND (ev.metadata->>'window_start') =
         to_char(ww.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)
UPDATE public.runs t SET window_id = r.root_id FROM root r
WHERE t.window_id = r.old_id
  -- collision guard: a window_id that is already a canvas_state event id is
  -- migrated — never rewrite it, even if a straggler ww.id collides numerically.
  AND NOT EXISTS (SELECT 1 FROM public.events g WHERE g.id = t.window_id AND g.semantic_type = 'canvas_state');

WITH root AS (
    SELECT ww.id AS old_id, ev.id AS root_id
    FROM public.watcher_windows ww
    JOIN public.events ev
      ON ev.semantic_type = 'canvas_state'
     AND ev.supersedes_event_id IS NULL
     AND (ev.metadata->>'watcher_id')::bigint = ww.watcher_id
     AND (ev.metadata->>'granularity') = ww.granularity
     AND (ev.metadata->>'window_start') =
         to_char(ww.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)
UPDATE public.watcher_window_events t SET window_id = r.root_id FROM root r
WHERE t.window_id = r.old_id
  -- collision guard: a window_id that is already a canvas_state event id is
  -- migrated — never rewrite it, even if a straggler ww.id collides numerically.
  AND NOT EXISTS (SELECT 1 FROM public.events g WHERE g.id = t.window_id AND g.semantic_type = 'canvas_state');

WITH root AS (
    SELECT ww.id AS old_id, ev.id AS root_id
    FROM public.watcher_windows ww
    JOIN public.events ev
      ON ev.semantic_type = 'canvas_state'
     AND ev.supersedes_event_id IS NULL
     AND (ev.metadata->>'watcher_id')::bigint = ww.watcher_id
     AND (ev.metadata->>'granularity') = ww.granularity
     AND (ev.metadata->>'window_start') =
         to_char(ww.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)
UPDATE public.event_classifications t SET window_id = r.root_id FROM root r
WHERE t.window_id = r.old_id
  -- collision guard: a window_id that is already a canvas_state event id is
  -- migrated — never rewrite it, even if a straggler ww.id collides numerically.
  AND NOT EXISTS (SELECT 1 FROM public.events g WHERE g.id = t.window_id AND g.semantic_type = 'canvas_state');

WITH root AS (
    SELECT ww.id AS old_id, ev.id AS root_id
    FROM public.watcher_windows ww
    JOIN public.events ev
      ON ev.semantic_type = 'canvas_state'
     AND ev.supersedes_event_id IS NULL
     AND (ev.metadata->>'watcher_id')::bigint = ww.watcher_id
     AND (ev.metadata->>'granularity') = ww.granularity
     AND (ev.metadata->>'window_start') =
         to_char(ww.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)
UPDATE public.events e
SET metadata = jsonb_set(e.metadata, '{window_id}', to_jsonb(r.root_id))
FROM root r
WHERE e.semantic_type = 'correction'
  AND (e.metadata->>'window_id')::bigint = r.old_id
  -- collision guard (see re-keys above).
  AND NOT EXISTS (
      SELECT 1 FROM public.events g
      WHERE g.id = (e.metadata->>'window_id')::bigint
        AND g.semantic_type = 'canvas_state');

-- (1c) Straggler provenance → run model (3a §d.1–d.3, all guarded/idempotent).
WITH win AS (
    SELECT ev.id AS root_id, ww.run_id AS legacy_run_id,
           ww.model_used, ww.run_metadata, ww.execution_time_ms, ww.client_id
    FROM public.watcher_windows ww
    JOIN public.events ev
      ON ev.semantic_type = 'canvas_state'
     AND ev.supersedes_event_id IS NULL
     AND (ev.metadata->>'watcher_id')::bigint = ww.watcher_id
     AND (ev.metadata->>'granularity') = ww.granularity
     AND (ev.metadata->>'window_start') =
         to_char(ww.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
)
UPDATE public.runs r
SET model_used   = COALESCE(r.model_used, win.model_used),
    run_metadata = jsonb_strip_nulls(
        COALESCE(r.run_metadata, win.run_metadata, '{}'::jsonb)
        || jsonb_build_object(
             'execution_time_ms',
             COALESCE((r.run_metadata->>'execution_time_ms')::bigint, win.execution_time_ms),
             'client_id',
             COALESCE(r.run_metadata->>'client_id', win.client_id)))
FROM win
WHERE (r.window_id = win.root_id OR r.id = win.legacy_run_id)
  AND (r.model_used IS NULL
       OR r.run_metadata IS NULL
       OR (r.run_metadata->>'execution_time_ms' IS NULL AND win.execution_time_ms IS NOT NULL)
       OR (r.run_metadata->>'client_id' IS NULL AND win.client_id IS NOT NULL));

UPDATE public.events ev
SET run_id = ww.run_id
FROM public.watcher_windows ww
WHERE ev.semantic_type = 'canvas_state'
  AND ev.supersedes_event_id IS NULL
  AND ev.run_id IS NULL
  AND ww.run_id IS NOT NULL
  AND (ev.metadata->>'watcher_id')::bigint = ww.watcher_id
  AND (ev.metadata->>'granularity') = ww.granularity
  AND (ev.metadata->>'window_start') =
      to_char(ww.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

UPDATE public.events ev
SET run_id = latest.run_id
FROM (
    SELECT window_id, MAX(id) AS run_id
    FROM public.runs
    WHERE run_type = 'watcher' AND window_id IS NOT NULL
    GROUP BY window_id
) latest
WHERE ev.semantic_type = 'canvas_state'
  AND ev.supersedes_event_id IS NULL
  AND ev.run_id IS NULL
  AND latest.window_id = ev.id;

WITH need AS (
    SELECT ev.id AS root_id, w.organization_id, ww.watcher_id,
           ww.model_used, ww.run_metadata, ww.execution_time_ms, ww.client_id,
           COALESCE(ww.created_at, ww.window_end) AS created_at
    FROM public.watcher_windows ww
    JOIN public.watchers w ON w.id = ww.watcher_id
    JOIN public.events ev
      ON ev.semantic_type = 'canvas_state'
     AND ev.supersedes_event_id IS NULL
     AND (ev.metadata->>'watcher_id')::bigint = ww.watcher_id
     AND (ev.metadata->>'granularity') = ww.granularity
     AND (ev.metadata->>'window_start') =
         to_char(ww.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    WHERE ev.run_id IS NULL
      AND (ww.model_used IS NOT NULL OR ww.run_metadata IS NOT NULL
           OR ww.execution_time_ms IS NOT NULL OR ww.client_id IS NOT NULL)
),
made AS (
    INSERT INTO public.runs (
        organization_id, run_type, status, watcher_id, window_id,
        model_used, run_metadata, created_at, completed_at
    )
    SELECT organization_id, 'watcher', 'completed', watcher_id, root_id,
           model_used,
           jsonb_strip_nulls(
               COALESCE(run_metadata, '{}'::jsonb)
               || jsonb_build_object(
                    'execution_time_ms', execution_time_ms,
                    'client_id',         client_id,
                    'source',            'canvas-provenance-backfill')),
           created_at, created_at
    FROM need
    RETURNING id, window_id
)
UPDATE public.events ev
SET run_id = made.id
FROM made
WHERE ev.id = made.window_id;

-- ── (2) Drop the table and the feedback-id sequence ─────────────────────────
-- CASCADE removes the remaining table-owned indexes/constraints with it.
-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.watcher_windows CASCADE;

-- Correction events now use their own event id as the feedback id; historical
-- 'wwff_<id>' origin_ids stay in the events spine and readers still parse them.
DROP SEQUENCE IF EXISTS public.watcher_window_field_feedback_id_seq;

-- migrate:down

-- Dev-only rollback: recreate the pre-drop shapes (data is NOT restored — the
-- canvas chains are the system of record; 3a's down can then re-add its FKs
-- against this empty table).
CREATE SEQUENCE IF NOT EXISTS public.watcher_window_field_feedback_id_seq;

CREATE TABLE IF NOT EXISTS public.watcher_windows (
    id bigint PRIMARY KEY,
    watcher_id bigint NOT NULL REFERENCES public.watchers(id) ON DELETE CASCADE,
    parent_window_id bigint REFERENCES public.watcher_windows(id) ON DELETE CASCADE,
    granularity text NOT NULL,
    window_start timestamptz NOT NULL,
    window_end timestamptz NOT NULL,
    content_analyzed bigint NOT NULL DEFAULT 0,
    extracted_data jsonb NOT NULL DEFAULT '{}'::jsonb,
    model_used text,
    execution_time_ms bigint,
    is_rollup boolean,
    source_window_ids bigint[],
    created_at timestamptz,
    version_id bigint REFERENCES public.watcher_versions(id),
    depth bigint,
    client_id text,
    run_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    run_id bigint REFERENCES public.runs(id) ON DELETE SET NULL,
    CONSTRAINT insight_windows_insight_id_granularity_window_start_key
        UNIQUE (watcher_id, granularity, window_start)
);

-- squawk-ignore require-concurrent-index-creation
CREATE INDEX IF NOT EXISTS idx_watcher_windows_watcher
    ON public.watcher_windows (watcher_id, granularity, window_start DESC);
