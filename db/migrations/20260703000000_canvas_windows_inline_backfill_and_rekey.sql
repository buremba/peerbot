-- migrate:up

-- ============================================================================
-- Canvas-on-events Phase 3a: retire the legacy watcher_windows WRITE path.
--
-- Watcher "windows" (canvases) are now supersede chains of
-- `semantic_type='canvas_state'` events (see packages/server/src/utils/
-- canvas-events.ts). The chain ROOT (supersedes_event_id IS NULL) is the window
-- identity; its event id is the `window_id` everywhere from this release on.
--
-- This migration makes canvas events the SOLE storage:
--   (a) Inline, set-based, idempotent canvas-root backfill so ANY upgrading
--       install gets a root for every existing watcher_windows row (mirrors the
--       deleted backfill-canvas-events.ts module's ensureCanvasEntity semantics
--       in pure SQL).
--   (b) Drop the four FK constraints window_id → watcher_windows(id) (columns
--       stay).
--   (c) Re-key those four window_id columns (+ correction events' advisory
--       metadata.window_id) from legacy watcher_windows ids to canvas ROOT
--       event ids. Idempotent: only rows whose window_id still matches a live
--       watcher_windows.id are re-keyed (already-re-keyed rows won't match).
--   (d) Add runs provenance columns (model_used, run_metadata) and backfill
--       them from watcher_windows via the run/window linkage.
--
-- The watcher_windows TABLE, its indexes, and its columns are deliberately NOT
-- dropped here (see TWO-PHASE below).
--
-- Prod scale is tiny (~33 windows / ~413 link rows) but upgrading installs may
-- carry thousands, so every statement is set-based (no per-row loops).
--
-- ── window_start canonical text ─────────────────────────────────────────────
-- window_start is stored in canvas metadata as canonical UTC ISO text, matching
-- JS Date.toISOString() EXACTLY, via
--   to_char(ts AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
-- so it collides on the existing text-keyed idx_canvas_chain_root partial unique
-- index and matches the TS write path byte-for-byte. Every canvas query is
-- scoped to semantic_type='canvas_state' so it NEVER touches the tab_event/
-- tab_snapshot BROWSER rows that also carry metadata.window_id.
--
-- ── MULTI-REPLICA (rolling deploy: 1 old pod + 1 new pod) ────────────────────
--   * FK drops (b): safe — dropping a constraint never blocks an old pod's
--     legacy INSERT/UPDATE/DELETE on watcher_windows.
--   * Re-key (c): only touches rows whose window_id currently equals a live
--     watcher_windows.id. An OLD pod that writes a NEW legacy window_id row
--     AFTER this migration ran is a straggler, caught by 3b's re-key below.
--   * runs provenance (d): additive columns; old pods ignore them.
--   The old pod keeps dual-writing watcher_windows and reading it; the new pod
--   reads canvases only. Both are correct because the inline backfill (a) makes
--   the canvas the projection of every legacy row, and the re-key points shared
--   link tables at ids the new pod resolves as canvas roots (old pod stops
--   reading those columns via watcher_windows once the FK is gone — its reads
--   go through watcher_window_events.window_id = watcher_windows.id joins, which
--   the straggler window it just wrote still satisfies for ITS OWN new rows).
--
-- ── TWO-PHASE FOLLOW-UP (Phase 3b — SEPARATE, LATER PR; do NOT run here) ──────
-- Once THIS release has fully rolled out (no old pod still dual-writing), a
-- later migration re-keys any stragglers old pods wrote during the overlap and
-- then drops the table. Exact 3b SQL:
--
--   -- 3b.1 Re-key stragglers: any window_id still pointing at a live
--   --      watcher_windows.id (a row an old pod inserted post-3a) → canvas root.
--   WITH root AS (
--     SELECT ww.id AS old_id, ev.id AS root_id
--     FROM watcher_windows ww
--     JOIN events ev
--       ON ev.semantic_type = 'canvas_state'
--      AND ev.supersedes_event_id IS NULL
--      AND (ev.metadata->>'watcher_id')::bigint = ww.watcher_id
--      AND (ev.metadata->>'granularity') = ww.granularity
--      AND (ev.metadata->>'window_start') =
--          to_char(ww.window_start AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
--   )
--   UPDATE watcher_reactions t SET window_id = r.root_id FROM root r WHERE t.window_id = r.old_id;
--   UPDATE runs                t SET window_id = r.root_id FROM root r WHERE t.window_id = r.old_id;
--   UPDATE watcher_window_events t SET window_id = r.root_id FROM root r WHERE t.window_id = r.old_id;
--   UPDATE event_classifications t SET window_id = r.root_id FROM root r WHERE t.window_id = r.old_id;
--   UPDATE events e
--     SET metadata = jsonb_set(e.metadata, '{window_id}', to_jsonb(r.root_id))
--     FROM root r
--     WHERE e.semantic_type = 'correction'
--       AND (e.metadata->>'window_id')::bigint = r.old_id;
--
--   -- 3b.2 Drop the table (CASCADE removes idx_watcher_windows_* and the
--   --      remaining is_rollup/source_window_ids/depth/parent_window_id columns
--   --      with it). Nothing reads or writes it after 3a fully rolled out.
--   DROP TABLE IF EXISTS public.watcher_windows CASCADE;
-- ============================================================================

-- ── (a) Inline canvas-root backfill ─────────────────────────────────────────
-- For every watcher_windows row WITHOUT a canvas root for its period, ensure the
-- lazy per-watcher canvas entity + entity_identities claim (namespace
-- 'watcher_canvas'), then insert the ROOT canvas_state event. Mirrors
-- ensureCanvasEntity: entity_type = org's non-view-backed 'canvas' type if
-- present else any non-view-backed org type; created_by = watcher.created_by
-- else an org owner/admin member; if no attributable user OR no usable entity
-- type, the root is inserted WITHOUT an entity anchor (entity_ids '{}').

-- (a.1) Create the per-watcher canvas ENTITY for watchers that have windows but
--       no live canvas identity yet, and that HAVE both an attributable creator
--       and a usable (non-view-backed) entity type. Set-based; ON CONFLICT
--       DO NOTHING tolerates the live-unique identity claim under concurrency.
WITH watchers_needing_canvas AS (
    SELECT DISTINCT
        w.id                AS watcher_id,
        w.organization_id,
        w.entity_ids,
        -- attributable creator: watcher.created_by if a live user, else an
        -- org owner/admin member (owner first).
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
        ) AS created_by
    FROM public.watchers w
    WHERE EXISTS (SELECT 1 FROM public.watcher_windows ww WHERE ww.watcher_id = w.id)
      AND NOT EXISTS (
          SELECT 1 FROM public.entity_identities ei
          JOIN public.entities e ON e.id = ei.entity_id
          WHERE ei.organization_id = w.organization_id
            AND ei.namespace = 'watcher_canvas'
            AND ei.identifier = w.id::text
            AND ei.deleted_at IS NULL
            AND e.deleted_at IS NULL
      )
),
resolved AS (
    SELECT
        wnc.watcher_id,
        wnc.organization_id,
        wnc.created_by,
        -- parent entity = watcher's first bound entity, else NULL (root canvas).
        (
            SELECT (regexp_split_to_array(trim(both '{}' FROM wnc.entity_ids::text), ','))[1]::bigint
            WHERE wnc.entity_ids IS NOT NULL
              AND trim(both '{}' FROM wnc.entity_ids::text) <> ''
        ) AS parent_entity_id,
        -- entity type: org 'canvas' type (non-view-backed) preferred, else any
        -- non-view-backed org type. Mirrors ensureCanvasEntity precedence.
        COALESCE(
            (
                SELECT et.id FROM public.entity_types et
                LEFT JOIN public.organization o ON o.id = et.organization_id
                WHERE et.slug = 'canvas'
                  AND et.deleted_at IS NULL
                  AND et.backing_sql IS NULL
                  AND (et.organization_id = wnc.organization_id OR o.visibility = 'public')
                ORDER BY (et.organization_id = wnc.organization_id) DESC, et.id ASC
                LIMIT 1
            ),
            (
                SELECT et.id FROM public.entity_types et
                WHERE et.organization_id = wnc.organization_id
                  AND et.deleted_at IS NULL
                  AND et.backing_sql IS NULL
                ORDER BY et.id ASC
                LIMIT 1
            )
        ) AS entity_type_id
    FROM watchers_needing_canvas wnc
    WHERE wnc.created_by IS NOT NULL
),
inserted_entities AS (
    INSERT INTO public.entities (
        organization_id, entity_type_id, name, slug, parent_id, metadata,
        created_by, created_at, updated_at
    )
    SELECT
        r.organization_id,
        r.entity_type_id,
        'Canvas · watcher ' || r.watcher_id,
        'watcher-canvas-' || r.watcher_id,
        r.parent_entity_id,
        jsonb_build_object('watcher_id', r.watcher_id, 'source', 'watcher_canvas'),
        r.created_by,
        current_timestamp,
        current_timestamp
    FROM resolved r
    WHERE r.entity_type_id IS NOT NULL
    ON CONFLICT DO NOTHING
    RETURNING id, (metadata->>'watcher_id')::bigint AS watcher_id, organization_id
)
INSERT INTO public.entity_identities (
    organization_id, entity_id, namespace, identifier, source_connector
)
SELECT ie.organization_id, ie.id, 'watcher_canvas', ie.watcher_id::text, 'watcher'
FROM inserted_entities ie
ON CONFLICT (organization_id, namespace, identifier) WHERE deleted_at IS NULL
DO NOTHING;

-- (a.2) Insert the ROOT canvas_state event for every window lacking one,
--       preserving watcher_windows.created_at. Anchors on the per-watcher canvas
--       entity when one exists (from a.1 or a prior write); otherwise entity_ids
--       '{}'. created_by mirrors the entity attribution (watcher.created_by else
--       org owner/admin), or NULL when the org has no member — events.created_by
--       is nullable so an unanchored, unattributed root is still valid.
--       ON CONFLICT on the text-keyed idx_canvas_chain_root partial unique index
--       makes replays a no-op.
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

-- (a.3) Fill the denormalized watcher_window_events.watcher_id for any legacy
--       link rows still missing it (belt-and-braces; the earlier migration
--       20260702100020 already did this, but a fresh install racing writes may
--       have added rows since).
UPDATE public.watcher_window_events wwe
SET watcher_id = ww.watcher_id
FROM public.watcher_windows ww
WHERE wwe.window_id = ww.id
  AND wwe.watcher_id IS NULL;

-- ── (b) Drop the four FK constraints window_id → watcher_windows(id) ─────────
-- Columns stay; only the constraints go so the columns can hold canvas root
-- event ids (which are NOT watcher_windows ids). IF EXISTS keeps the migration
-- idempotent and safe on installs where a constraint was already renamed/dropped.
ALTER TABLE public.watcher_reactions     DROP CONSTRAINT IF EXISTS watcher_reactions_window_id_fkey;
ALTER TABLE public.runs                  DROP CONSTRAINT IF EXISTS runs_window_id_fkey;
ALTER TABLE public.watcher_window_events DROP CONSTRAINT IF EXISTS insight_window_events_window_id_fkey;
ALTER TABLE public.event_classifications DROP CONSTRAINT IF EXISTS event_classifications_window_id_fkey;

-- ── (c) Re-key window_id columns → canvas ROOT event ids ─────────────────────
-- root() maps each legacy watcher_windows.id to the canvas root event id for the
-- same (watcher, granularity, window_start period). The FK drops above must have
-- landed first. Every UPDATE is idempotent: it only touches rows whose window_id
-- STILL equals a live watcher_windows.id, so a re-run (or an already-re-keyed
-- row pointing at an events id) is a no-op.
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
UPDATE public.watcher_reactions t
SET window_id = r.root_id
FROM root r
WHERE t.window_id = r.old_id;

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
UPDATE public.runs t
SET window_id = r.root_id
FROM root r
WHERE t.window_id = r.old_id;

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
UPDATE public.watcher_window_events t
SET window_id = r.root_id
FROM root r
WHERE t.window_id = r.old_id;

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
UPDATE public.event_classifications t
SET window_id = r.root_id
FROM root r
WHERE t.window_id = r.old_id;

-- Re-key correction events' advisory metadata.window_id the same way. This is
-- key-plumbing on ADVISORY lineage metadata (which window a correction targets),
-- NOT event content — the `events` append-only invariant applies to payload, and
-- there is precedent for post-insert metadata maintenance (search_tsv,
-- superseded_by). Scoped to semantic_type='correction' so it never rewrites a
-- canvas_state or browser row's window_id.
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
  AND (e.metadata->>'window_id')::bigint = r.old_id;

-- ── (d) runs provenance columns + backfill ──────────────────────────────────
-- The completion write path records model/run metadata on the RUN row, and the
-- canvas_windows view (e) resolves ALL window provenance through the chain
-- head's run_id — no legacy fallback in any read path. To make historical data
-- uniform with that model, this section (d.1) copies legacy provenance onto
-- every run associated with a legacy window (merging execution_time_ms and
-- client_id into run_metadata — runs has no client_id column, so the legacy
-- PAT/device id survives as run_metadata data; the view's client_id column
-- stays live-path only), (d.2) stamps each canvas root's run_id with its
-- window's producing run, and (d.3) synthesizes a completed watcher run for
-- legacy windows that carry provenance but never had a run row (the execution
-- demonstrably happened; the run row is its historical record, tagged
-- run_metadata.source='canvas-provenance-backfill'). Afterwards every window,
-- live or migrated, resolves provenance identically.
ALTER TABLE public.runs ADD COLUMN IF NOT EXISTS model_used text;
ALTER TABLE public.runs ADD COLUMN IF NOT EXISTS run_metadata jsonb;

-- (d.1) Copy legacy provenance onto runs linked to a legacy window — via the
--       re-keyed runs.window_id (root id) OR the window's own run_id pointer.
--       Existing run values always win; only missing fields are filled.
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

-- (d.2) Stamp each canvas root's run_id: the window's own run pointer first,
--       else the newest run whose (re-keyed) window_id is the root. Guarded on
--       run_id IS NULL → idempotent; never touches a live dual-write root.
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

-- (d.3) Synthesize the historical run for legacy windows with provenance but
--       no run row at all, and link the root to it (events.run_id FK → runs is
--       ON DELETE SET NULL, so removing these reverts the link).
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

-- ── (e) canvas_windows view — THE window read surface ───────────────────────
-- One row per window (canvas chain ROOT); live analysis payload from the chain
-- HEAD (superseded_by IS NULL — same-tx dual-write since 20260702200000, view
-- flip 20260702300020); provenance from the head's run. Every code read site
-- and query_sql exposure selects FROM this view instead of re-implementing the
-- chain resolution. Postgres macro-expands views, so watcher_id/granularity
-- predicates push down onto idx_canvas_chain_root / idx_canvas_state_listing
-- exactly like the inlined subquery (EXPLAIN-verified).
CREATE VIEW public.canvas_windows AS
SELECT
    root.id,
    root.organization_id,
    (root.metadata->>'watcher_id')::bigint  AS watcher_id,
    root.metadata->>'granularity'           AS granularity,
    (root.metadata->>'window_start')::timestamptz AS window_start,
    (root.metadata->>'window_end')::timestamptz   AS window_end,
    (root.metadata->>'version_id')::bigint  AS version_id,
    root.created_at,
    head.payload_data                       AS extracted_data,
    COALESCE((head.metadata->>'content_analyzed')::int, 0) AS content_analyzed,
    head.client_id,
    head.run_id,
    run.model_used,
    run.run_metadata,
    COALESCE(
        (run.run_metadata->>'execution_time_ms')::int,
        CASE
            WHEN run.completed_at IS NOT NULL AND run.claimed_at IS NOT NULL
                THEN (EXTRACT(EPOCH FROM (run.completed_at - run.claimed_at)) * 1000)::int
            ELSE NULL
        END
    ) AS execution_time_ms
FROM public.events root
LEFT JOIN LATERAL (
    SELECT e.payload_data, e.metadata, e.client_id, e.run_id
    FROM public.events e
    WHERE e.semantic_type = 'canvas_state'
      AND (e.metadata->>'watcher_id')::bigint = (root.metadata->>'watcher_id')::bigint
      AND (e.metadata->>'granularity') = (root.metadata->>'granularity')
      AND (e.metadata->>'window_start') = (root.metadata->>'window_start')
      AND e.superseded_by IS NULL
    LIMIT 1
) head ON TRUE
LEFT JOIN public.runs run ON run.id = head.run_id
WHERE root.semantic_type = 'canvas_state'
  AND root.supersedes_event_id IS NULL;

-- migrate:down

DROP VIEW IF EXISTS public.canvas_windows;

-- Reversible parts only. The inline backfill (a) and re-key (c) are NOT reverted
-- (canvas roots are the system of record on the way forward; the append-only
-- events spine has no clean delete, and re-pointing shared columns back to
-- watcher_windows ids would require the reverse period join which is lossy for
-- rows whose legacy window was concurrently modified). Dev rollback restores the
-- dropped FKs and drops the added columns.
-- Remove the synthesized provenance runs first (events.run_id FK is
-- ON DELETE SET NULL, so linked roots revert automatically).
DELETE FROM public.runs
WHERE run_metadata->>'source' = 'canvas-provenance-backfill';

ALTER TABLE public.runs DROP COLUMN IF EXISTS run_metadata;
ALTER TABLE public.runs DROP COLUMN IF EXISTS model_used;

-- NOT VALID: the re-added FKs skip the validating table scan (rows re-keyed to
-- canvas root event ids would fail validation anyway); a dev rollback only needs
-- the constraint in place for NEW rows. No VALIDATE follows by design.
ALTER TABLE public.event_classifications
  ADD CONSTRAINT event_classifications_window_id_fkey
  FOREIGN KEY (window_id) REFERENCES public.watcher_windows(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.watcher_window_events
  ADD CONSTRAINT insight_window_events_window_id_fkey
  FOREIGN KEY (window_id) REFERENCES public.watcher_windows(id) ON DELETE CASCADE NOT VALID;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_window_id_fkey
  FOREIGN KEY (window_id) REFERENCES public.watcher_windows(id) ON DELETE SET NULL NOT VALID;
ALTER TABLE public.watcher_reactions
  ADD CONSTRAINT watcher_reactions_window_id_fkey
  FOREIGN KEY (window_id) REFERENCES public.watcher_windows(id) ON DELETE CASCADE NOT VALID;
