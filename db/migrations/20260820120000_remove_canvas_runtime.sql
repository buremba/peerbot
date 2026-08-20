-- migrate:up

-- canvas-result-cutover:start

-- Resolve the retired Canvas chains once. Every later conversion uses the
-- chain root plus the run that existed at the historical row's timestamp.
CREATE TEMP TABLE canvas_members (
  event_id bigint PRIMARY KEY,
  legacy_id bigint NOT NULL,
  run_id bigint,
  automation_id bigint,
  organization_id text NOT NULL,
  payload_data jsonb,
  metadata jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  superseded_by bigint
) ON COMMIT DROP;

WITH RECURSIVE canvas_lineage AS (
  SELECT event.id AS event_id, event.id AS legacy_id
  FROM public.events event
  WHERE event.semantic_type = 'canvas_state'
    AND event.supersedes_event_id IS NULL

  UNION ALL

  SELECT child.id, parent.legacy_id
  FROM public.events child
  JOIN canvas_lineage parent ON parent.event_id = child.supersedes_event_id
  WHERE child.semantic_type = 'canvas_state'
)
INSERT INTO canvas_members (
  event_id, legacy_id, run_id, automation_id, organization_id,
  payload_data, metadata, created_at, superseded_by
)
SELECT
  event.id, lineage.legacy_id, event.run_id, event.automation_id,
  event.organization_id, event.payload_data, COALESCE(event.metadata, '{}'::jsonb),
  event.created_at, event.superseded_by
FROM canvas_lineage lineage
JOIN public.events event ON event.id = lineage.event_id;

-- squawk-ignore require-concurrent-index-creation -- temporary relation; CONCURRENTLY is unsupported
CREATE INDEX IF NOT EXISTS canvas_members_history
  ON canvas_members (legacy_id, created_at DESC, event_id DESC)
  WHERE run_id IS NOT NULL;

DO $assert_canvas_lineage$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.events event
    LEFT JOIN canvas_members member ON member.event_id = event.id
    WHERE event.semantic_type = 'canvas_state'
      AND member.event_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot retire Canvas: a canvas_state event has no valid chain root';
  END IF;
END
$assert_canvas_lineage$;

-- Preserve each producing run's own result first. This matters when a later
-- replacement run superseded the same Canvas chain.
WITH result_event AS (
  SELECT DISTINCT ON (member.run_id)
    member.run_id, member.payload_data, member.metadata
  FROM canvas_members member
  JOIN public.runs run ON run.id = member.run_id
  WHERE member.run_id IS NOT NULL
    AND run.run_type = 'automation'
  ORDER BY member.run_id, member.created_at DESC, member.event_id DESC
)
UPDATE public.runs run
SET action_output = COALESCE(result_event.payload_data, run.action_output),
    approved_input = COALESCE(run.approved_input, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
        'window_start', result_event.metadata->>'window_start',
        'window_end', result_event.metadata->>'window_end',
        'granularity', result_event.metadata->>'granularity',
        'version_id', result_event.metadata->'version_id'
      )),
    run_metadata = (COALESCE(run.run_metadata, '{}'::jsonb) - 'automation_run_id' - 'run_id')
      || CASE
        WHEN result_event.metadata ? 'content_analyzed'
          THEN jsonb_build_object('content_analyzed', result_event.metadata->'content_analyzed')
        ELSE '{}'::jsonb
      END
FROM result_event
WHERE run.id = result_event.run_id;

-- Canvas rows imported from watcher_windows can predate the run ledger. Reuse
-- a historical run already keyed to the Canvas root; otherwise synthesize the
-- completed Automation run that the persisted result proves occurred.
CREATE TEMP TABLE runless_canvas_run_map (
  legacy_id bigint PRIMARY KEY,
  run_id bigint NOT NULL,
  head_event_id bigint NOT NULL,
  head_payload_data jsonb,
  synthesized boolean NOT NULL
) ON COMMIT DROP;

INSERT INTO runless_canvas_run_map (
  legacy_id, run_id, head_event_id, head_payload_data, synthesized
)
SELECT
  head.legacy_id,
  COALESCE(owner.run_id, nextval(pg_get_serial_sequence('public.runs', 'id'))),
  head.event_id,
  head.payload_data,
  owner.run_id IS NULL
FROM canvas_members head
JOIN public.automations automation
  ON automation.id = head.automation_id
 AND automation.organization_id = head.organization_id
LEFT JOIN LATERAL (
  SELECT run.id AS run_id
  FROM public.runs run
  WHERE run.window_id = head.legacy_id
    AND run.run_type = 'automation'
    AND run.automation_id = head.automation_id
    AND run.organization_id = head.organization_id
  ORDER BY run.id DESC
  LIMIT 1
) owner ON true
WHERE head.superseded_by IS NULL
  AND (
    head.metadata->>'automation_id' = head.automation_id::text
    OR head.metadata->>'watcher_id' = head.automation_id::text
  )
  AND head.metadata->>'window_start' IS NOT NULL
  AND head.metadata->>'window_end' IS NOT NULL
  AND head.metadata->>'granularity' IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM canvas_members member
    JOIN public.runs run
      ON run.id = member.run_id
     AND run.run_type = 'automation'
    WHERE member.legacy_id = head.legacy_id
      AND member.run_id IS NOT NULL
  );

INSERT INTO public.runs (
  id, organization_id, run_type, automation_id, approval_status, status,
  outcome, action_output, approved_input, run_metadata, idempotency_key,
  created_at, completed_at
)
SELECT
  runless.run_id,
  head.organization_id,
  'automation',
  head.automation_id,
  'auto',
  'completed',
  'scoreable',
  head.payload_data,
  jsonb_strip_nulls(jsonb_build_object(
    'automation_id', head.automation_id,
    'window_start', head.metadata->>'window_start',
    'window_end', head.metadata->>'window_end',
    'dispatch_source', 'scheduled',
    'version_id', head.metadata->'version_id',
    'granularity', head.metadata->>'granularity'
  )),
  (CASE
    WHEN head.metadata ? 'content_analyzed'
      THEN jsonb_build_object('content_analyzed', head.metadata->'content_analyzed')
    ELSE '{}'::jsonb
  END) || (CASE
    WHEN head.payload_data = '{}'::jsonb
      AND head.metadata->'content_analyzed' = '0'::jsonb
      THEN '{"skipped_unchanged":true}'::jsonb
    ELSE '{}'::jsonb
  END),
  concat(
    'automation:', head.automation_id, ':scheduled:',
    head.metadata->>'window_start', ':', head.metadata->>'window_end'
  ),
  head.created_at,
  head.created_at
FROM runless_canvas_run_map runless
JOIN canvas_members head ON head.event_id = runless.head_event_id
WHERE runless.synthesized;

-- A current head may instead be a human correction with no run_id. Attribute
-- that corrected payload to the latest producing run in the chain.
CREATE TEMP TABLE canvas_run_map (
  legacy_id bigint PRIMARY KEY,
  run_id bigint NOT NULL,
  head_event_id bigint NOT NULL,
  head_payload_data jsonb
) ON COMMIT DROP;

INSERT INTO canvas_run_map (legacy_id, run_id, head_event_id, head_payload_data)
SELECT DISTINCT ON (head.legacy_id)
  head.legacy_id, owner.run_id, head.event_id, head.payload_data
FROM canvas_members head
JOIN LATERAL (
  SELECT member.run_id
  FROM canvas_members member
  JOIN public.runs run
    ON run.id = member.run_id
   AND run.run_type = 'automation'
  WHERE member.legacy_id = head.legacy_id
    AND member.run_id IS NOT NULL
    AND member.created_at <= head.created_at
  ORDER BY member.created_at DESC, member.event_id DESC
  LIMIT 1
) owner ON true
WHERE head.superseded_by IS NULL
ORDER BY head.legacy_id, head.created_at DESC, head.event_id DESC;

INSERT INTO canvas_run_map (legacy_id, run_id, head_event_id, head_payload_data)
SELECT legacy_id, run_id, head_event_id, head_payload_data
FROM runless_canvas_run_map;

DO $assert_canvas_heads$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM canvas_members head
    LEFT JOIN canvas_run_map mapping ON mapping.legacy_id = head.legacy_id
    WHERE head.superseded_by IS NULL
      AND mapping.run_id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot retire Canvas: a current result has no producing Automation run';
  END IF;
END
$assert_canvas_heads$;

UPDATE public.runs run
SET action_output = COALESCE(mapping.head_payload_data, run.action_output),
    approved_input = COALESCE(run.approved_input, '{}'::jsonb)
      || jsonb_strip_nulls(jsonb_build_object(
        'window_start', head.metadata->>'window_start',
        'window_end', head.metadata->>'window_end',
        'granularity', head.metadata->>'granularity',
        'version_id', head.metadata->'version_id'
      )),
    run_metadata = (COALESCE(run.run_metadata, '{}'::jsonb) - 'automation_run_id' - 'run_id')
      || CASE
        WHEN head.metadata ? 'content_analyzed'
          THEN jsonb_build_object('content_analyzed', head.metadata->'content_analyzed')
        ELSE '{}'::jsonb
      END
FROM canvas_run_map mapping
JOIN canvas_members head ON head.event_id = mapping.head_event_id
WHERE run.id = mapping.run_id;

-- canvas-result-cutover:end

-- Child work used the Canvas root as its parent key. Prefer the producer that
-- existed when the child was created; trusted initiator_ref.run_id wins when
-- present because it was stamped directly by the creating run.
WITH parent_for_child AS (
  SELECT child.id AS child_id, child.run_type AS child_run_type, COALESCE((
    SELECT member.run_id
    FROM canvas_members member
    WHERE member.legacy_id = current.legacy_id
      AND member.run_id IS NOT NULL
      AND member.created_at <= child.created_at
    ORDER BY member.created_at DESC, member.event_id DESC
    LIMIT 1
  ), current.run_id) AS parent_run_id
  FROM public.runs child
  JOIN canvas_run_map current ON current.legacy_id = child.window_id
  WHERE child.window_id IS NOT NULL
)
UPDATE public.runs child
SET window_id = CASE
  WHEN parent.child_run_type = 'automation' OR parent.parent_run_id = child.id THEN NULL
  ELSE parent.parent_run_id
END
FROM parent_for_child parent
WHERE child.id = parent.child_id;

UPDATE public.runs child
SET window_id = parent.id
FROM public.runs parent
WHERE child.initiator_ref->>'run_id' ~ '^\d+$'
  AND parent.id = (child.initiator_ref->>'run_id')::bigint
  AND parent.id <> child.id
  AND parent.organization_id = child.organization_id;

WITH source_for_link AS (
  SELECT link.id, COALESCE((
    SELECT member.run_id
    FROM canvas_members member
    WHERE member.legacy_id = current.legacy_id
      AND member.run_id IS NOT NULL
      AND member.created_at <= COALESCE(link.created_at, 'infinity'::timestamptz)
    ORDER BY member.created_at DESC, member.event_id DESC
    LIMIT 1
  ), current.run_id) AS run_id
  FROM public.automation_window_events link
  JOIN canvas_run_map current ON current.legacy_id = link.window_id
)
UPDATE public.automation_window_events link
SET window_id = source.run_id
FROM source_for_link source
WHERE link.id = source.id;

WITH source_for_classification AS (
  SELECT classification.id, COALESCE((
    SELECT member.run_id
    FROM canvas_members member
    WHERE member.legacy_id = current.legacy_id
      AND member.run_id IS NOT NULL
      AND member.created_at <= COALESCE(classification.created_at, 'infinity'::timestamptz)
    ORDER BY member.created_at DESC, member.event_id DESC
    LIMIT 1
  ), current.run_id) AS run_id
  FROM public.event_classifications classification
  JOIN canvas_run_map current ON current.legacy_id = classification.window_id
)
UPDATE public.event_classifications classification
SET window_id = source.run_id
FROM source_for_classification source
WHERE classification.id = source.id;

UPDATE public.event_classifications classification
SET window_id = NULL
WHERE classification.window_id IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM public.runs run WHERE run.id = classification.window_id);

WITH source_for_reaction AS (
  SELECT reaction.id, COALESCE((
    SELECT member.run_id
    FROM canvas_members member
    WHERE member.legacy_id = current.legacy_id
      AND member.run_id IS NOT NULL
      AND member.created_at <= COALESCE(reaction.created_at, 'infinity'::timestamptz)
    ORDER BY member.created_at DESC, member.event_id DESC
    LIMIT 1
  ), current.run_id) AS run_id
  FROM public.automation_reactions reaction
  JOIN canvas_run_map current ON current.legacy_id = reaction.window_id
)
UPDATE public.automation_reactions reaction
SET window_id = source.run_id
FROM source_for_reaction source
WHERE reaction.id = source.id;

-- An early reaction writer stored automation_id in window_id instead of the
-- Canvas root. Recover only the unambiguous same-organization result whose
-- declared window contains the reaction timestamp; ambiguous rows still fail
-- the assertion below instead of being silently misattributed.
-- orphan-reaction-cutover:start
WITH orphan_reaction_candidate AS (
  SELECT reaction.id, current.run_id
  FROM public.automation_reactions reaction
  LEFT JOIN public.runs existing
    ON existing.id = reaction.window_id
   AND existing.organization_id = reaction.organization_id
   AND existing.automation_id = reaction.automation_id
  JOIN canvas_run_map current ON true
  JOIN canvas_members head ON head.event_id = current.head_event_id
  WHERE existing.id IS NULL
    AND reaction.window_id = reaction.automation_id
    AND head.organization_id = reaction.organization_id
    AND head.automation_id = reaction.automation_id
    AND reaction.created_at >= (head.metadata->>'window_start')::timestamptz
    AND reaction.created_at <= (head.metadata->>'window_end')::timestamptz
), source_for_orphan_reaction AS (
  SELECT id, min(run_id) AS run_id
  FROM orphan_reaction_candidate
  GROUP BY id
  HAVING count(*) = 1
)
UPDATE public.automation_reactions reaction
SET window_id = source.run_id
FROM source_for_orphan_reaction source
WHERE reaction.id = source.id;
-- orphan-reaction-cutover:end

WITH source_for_merge AS (
  SELECT operation.id, COALESCE((
    SELECT member.run_id
    FROM canvas_members member
    WHERE member.legacy_id = current.legacy_id
      AND member.run_id IS NOT NULL
      AND member.created_at <= operation.created_at
    ORDER BY member.created_at DESC, member.event_id DESC
    LIMIT 1
  ), current.run_id) AS run_id
  FROM public.entity_merge_operations operation
  JOIN canvas_run_map current ON current.legacy_id = operation.window_id
  WHERE operation.source_run_id IS NULL
)
UPDATE public.entity_merge_operations operation
SET source_run_id = source.run_id
FROM source_for_merge source
WHERE operation.id = source.id;

-- Rewrite only Automation provenance. Browser events also use window_id for a
-- real browser window and must remain untouched.
WITH source_for_correction AS (
  SELECT event.id, COALESCE((
    SELECT member.run_id
    FROM canvas_members member
    WHERE member.legacy_id = current.legacy_id
      AND member.run_id IS NOT NULL
      AND member.created_at <= event.created_at
    ORDER BY member.created_at DESC, member.event_id DESC
    LIMIT 1
  ), current.run_id) AS run_id
  FROM public.events event
  JOIN canvas_run_map current
    ON event.metadata->>'window_id' ~ '^\d+$'
   AND (event.metadata->>'window_id')::bigint = current.legacy_id
  WHERE event.semantic_type = 'correction'
)
UPDATE public.events event
SET run_id = COALESCE(event.run_id, source.run_id),
    metadata = event.metadata - 'window_id' - 'run_id'
FROM source_for_correction source
WHERE event.id = source.id;

-- Approval events own their approval run in events.run_id. The Automation run
-- that produced a batched proposal is distinct and lives at source_run_id.
WITH source_for_approval AS (
  SELECT event.id, COALESCE((
    SELECT member.run_id
    FROM canvas_members member
    WHERE member.legacy_id = current.legacy_id
      AND member.run_id IS NOT NULL
      AND member.created_at <= event.created_at
    ORDER BY member.created_at DESC, member.event_id DESC
    LIMIT 1
  ), current.run_id) AS source_run_id
  FROM public.events event
  JOIN canvas_run_map current
    ON event.metadata->>'window_id' ~ '^\d+$'
   AND (event.metadata->>'window_id')::bigint = current.legacy_id
  WHERE event.interaction_type = 'approval'
)
UPDATE public.events event
SET metadata = (event.metadata - 'window_id' - 'run_id')
  || jsonb_build_object('source_run_id', source.source_run_id)
FROM source_for_approval source
WHERE event.id = source.id;

-- change_set and other Automation-authored rows already carry events.run_id.
UPDATE public.events event
SET metadata = event.metadata - 'window_id' - 'source_window_id'
WHERE event.automation_id IS NOT NULL
  AND event.metadata->>'window_id' ~ '^\d+$'
  AND EXISTS (
    SELECT 1
    FROM canvas_run_map mapping
    WHERE mapping.legacy_id = (event.metadata->>'window_id')::bigint
  );

-- Remove duplicate event-level copies now that events.run_id is canonical.
UPDATE public.events
SET metadata = metadata - 'run_id'
WHERE run_id IS NOT NULL
  AND automation_id IS NOT NULL
  AND metadata ? 'run_id';

WITH source_for_entity AS (
  SELECT entity.id, COALESCE((
    SELECT member.run_id
    FROM canvas_members member
    WHERE member.legacy_id = current.legacy_id
      AND member.run_id IS NOT NULL
      AND member.created_at <= entity.created_at
    ORDER BY member.created_at DESC, member.event_id DESC
    LIMIT 1
  ), current.run_id) AS run_id
  FROM public.entities entity
  JOIN canvas_run_map current
    ON entity.metadata->>'window_id' ~ '^\d+$'
   AND (entity.metadata->>'window_id')::bigint = current.legacy_id
  WHERE entity.metadata->>'source' = 'automation_promotion'
)
UPDATE public.entities entity
SET metadata = (entity.metadata - 'window_id') || jsonb_build_object('run_id', source.run_id)
FROM source_for_entity source
WHERE entity.id = source.id;

UPDATE public.runs
SET action_input = action_input - 'window_id' - 'source_window_id',
    approved_input = approved_input - 'window_id' - 'source_window_id',
    initiator_ref = initiator_ref - 'window_id',
    run_metadata = run_metadata - 'automation_run_id' - 'run_id'
WHERE action_input ?| ARRAY['window_id', 'source_window_id']
   OR approved_input ?| ARRAY['window_id', 'source_window_id']
   OR initiator_ref ? 'window_id'
   OR run_metadata ?| ARRAY['automation_run_id', 'run_id'];

DO $assert_run_mapping$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.automation_window_events link
    LEFT JOIN public.runs run ON run.id = link.window_id
    WHERE run.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot retire Canvas: an Automation content link has no producing run';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.automation_reactions reaction
    LEFT JOIN public.runs run
      ON run.id = reaction.window_id
     AND run.organization_id = reaction.organization_id
     AND run.automation_id = reaction.automation_id
    WHERE run.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot retire Canvas: an Automation reaction has no producing run';
  END IF;
END
$assert_run_mapping$;

-- Retire the internal Canvas entity/type bookkeeping. User-authored entities
-- whose type happens to contain the word canvas are not matched.
CREATE TEMP TABLE retired_canvas_entities (id bigint PRIMARY KEY) ON COMMIT DROP;

INSERT INTO retired_canvas_entities (id)
SELECT DISTINCT entity.id
FROM public.entities entity
LEFT JOIN public.entity_identities identity
  ON identity.entity_id = entity.id
 AND identity.organization_id = entity.organization_id
 AND identity.namespace = 'automation_canvas'
WHERE entity.metadata->>'source' = 'automation_canvas'
   OR identity.id IS NOT NULL;

UPDATE public.entities entity
SET deleted_at = COALESCE(entity.deleted_at, current_timestamp),
    updated_at = current_timestamp
FROM retired_canvas_entities retired
WHERE entity.id = retired.id;

UPDATE public.entity_identities identity
SET deleted_at = COALESCE(identity.deleted_at, current_timestamp),
    updated_at = current_timestamp
FROM retired_canvas_entities retired
WHERE identity.entity_id = retired.id
  AND identity.namespace = 'automation_canvas';

UPDATE public.entity_types type
SET deleted_at = COALESCE(type.deleted_at, current_timestamp),
    updated_at = current_timestamp
WHERE type.slug = '$canvas';

-- The result is now on runs.action_output. Supersede each live Canvas head with
-- a normal append-only tombstone so ordinary reads cannot expose a second live
-- result surface while direct history remains auditable.
WITH tombstone AS (
  INSERT INTO public.events (
    organization_id, entity_ids, origin_id, payload_type, payload_data,
    metadata, semantic_type, supersedes_event_id, occurred_at, created_at
  )
  SELECT
    head.organization_id, '{}'::bigint[], 'canvas_retired_' || head.event_id::text,
    'empty', '{}'::jsonb,
    jsonb_build_object('tombstone', true, 'deleted_event_id', head.event_id),
    'tombstone', head.event_id, current_timestamp, current_timestamp
  FROM canvas_members head
  WHERE head.superseded_by IS NULL
  RETURNING id, supersedes_event_id
)
UPDATE public.events head
SET superseded_by = tombstone.id
FROM tombstone
WHERE head.id = tombstone.supersedes_event_id;

DROP VIEW IF EXISTS public.canvas_windows;

-- squawk-ignore require-concurrent-index-deletion -- Canvas rows are retired in this transaction
DROP INDEX IF EXISTS public.idx_canvas_chain_root;
-- squawk-ignore require-concurrent-index-deletion -- Canvas rows are retired in this transaction
DROP INDEX IF EXISTS public.idx_canvas_state_listing;

-- squawk-ignore ban-drop-column -- duplicate Canvas grouping identity is retired
ALTER TABLE public.entity_merge_operations DROP COLUMN IF EXISTS window_id;
-- squawk-ignore ban-drop-column -- Canvas notification routing had no runtime consumer
ALTER TABLE public.automations
  DROP COLUMN IF EXISTS notification_channel,
  DROP COLUMN IF EXISTS notification_priority;

-- squawk-ignore require-concurrent-index-deletion -- runs is locked immediately below for the contract rename
DROP INDEX IF EXISTS public.runs_entity_change_pending_dedupe_v2;
-- squawk-ignore require-concurrent-index-deletion -- duplicate of the table's UNIQUE constraint
DROP INDEX IF EXISTS public.idx_automation_window_events_unique;

-- squawk-ignore renaming-table,prefer-robust-stmts -- intentional one-release contract cutover; dbmate wraps the migration
ALTER TABLE public.automation_window_events RENAME TO automation_run_events;
-- squawk-ignore renaming-column,prefer-robust-stmts -- intentional one-release contract cutover; dbmate wraps the migration
ALTER TABLE public.runs RENAME COLUMN window_id TO parent_run_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- intentional one-release contract cutover; dbmate wraps the migration
ALTER TABLE public.automation_run_events RENAME COLUMN window_id TO run_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- intentional one-release contract cutover; dbmate wraps the migration
ALTER TABLE public.event_classifications RENAME COLUMN window_id TO run_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- intentional one-release contract cutover; dbmate wraps the migration
ALTER TABLE public.automation_reactions RENAME COLUMN window_id TO source_run_id;

-- Constraint and index identifiers do not follow table/column renames. Rename
-- every affected catalog object so the retired vocabulary is absent from the
-- resulting schema, including baseline-era insight_window_content names.
DO $rename_constraints$
DECLARE
  item record;
  renamed text;
BEGIN
  FOR item IN
    SELECT constraint_row.conname, table_row.relname AS table_name
    FROM pg_constraint constraint_row
    JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
    WHERE namespace_row.nspname = 'public'
      AND table_row.relname IN (
        'automation_run_events', 'event_classifications',
        'automation_reactions', 'runs'
      )
  LOOP
    renamed := item.conname;
    IF item.table_name = 'automation_run_events' THEN
      renamed := replace(renamed, 'insight_window_content', 'automation_run_events');
      renamed := replace(renamed, 'insight_window_events', 'automation_run_events');
      renamed := replace(renamed, 'automation_window_events', 'automation_run_events');
      renamed := replace(renamed, 'window_id', 'run_id');
      renamed := replace(renamed, 'content_id', 'event_id');
    ELSIF item.table_name = 'event_classifications' THEN
      renamed := replace(renamed, 'window_id', 'run_id');
    ELSIF item.table_name = 'automation_reactions' THEN
      renamed := replace(renamed, 'window_id', 'source_run_id');
    ELSIF item.table_name = 'runs' THEN
      renamed := replace(renamed, 'window_id', 'parent_run_id');
    END IF;
    IF renamed <> item.conname THEN
      EXECUTE format(
        'ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
        item.table_name, item.conname, renamed
      );
    END IF;
  END LOOP;
END
$rename_constraints$;

DO $rename_indexes$
DECLARE
  item record;
  renamed text;
BEGIN
  FOR item IN
    SELECT index_row.relname AS index_name, table_row.relname AS table_name
    FROM pg_index index_entry
    JOIN pg_class index_row ON index_row.oid = index_entry.indexrelid
    JOIN pg_class table_row ON table_row.oid = index_entry.indrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
    WHERE namespace_row.nspname = 'public'
      AND table_row.relname IN (
        'automation_run_events', 'event_classifications',
        'automation_reactions', 'runs'
      )
  LOOP
    renamed := item.index_name;
    IF item.table_name = 'automation_run_events' THEN
      renamed := replace(renamed, 'insight_window_content', 'automation_run_events');
      renamed := replace(renamed, 'insight_window_events', 'automation_run_events');
      renamed := replace(renamed, 'automation_window_events', 'automation_run_events');
      renamed := replace(renamed, 'window_id', 'run_id');
      renamed := replace(renamed, 'content_id', 'event_id');
      renamed := replace(renamed, '_window', '_run');
    ELSIF item.table_name = 'event_classifications' THEN
      renamed := replace(renamed, 'window_id', 'run_id');
      renamed := replace(renamed, '_window', '_run');
    ELSIF item.table_name = 'automation_reactions' THEN
      renamed := replace(renamed, 'window_id', 'source_run_id');
      renamed := replace(renamed, '_window', '_source_run');
    ELSIF item.table_name = 'runs' THEN
      renamed := replace(renamed, 'window_id', 'parent_run_id');
      renamed := replace(renamed, '_window', '_parent_run');
    END IF;
    IF renamed <> item.index_name THEN
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', item.index_name, renamed);
    END IF;
  END LOOP;
END
$rename_indexes$;

DO $rename_sequence$
BEGIN
  IF to_regclass('public.automation_window_content_id_seq') IS NOT NULL THEN
    IF to_regclass('public.automation_run_events_id_seq') IS NOT NULL THEN
      RAISE EXCEPTION 'Both retired and canonical Automation run-event sequences exist';
    END IF;
    ALTER SEQUENCE public.automation_window_content_id_seq
      RENAME TO automation_run_events_id_seq;
  ELSIF to_regclass('public.automation_run_events_id_seq') IS NULL THEN
    RAISE EXCEPTION 'Automation run-event sequence is missing';
  END IF;
END
$rename_sequence$;

-- squawk-ignore prefer-robust-stmts -- constraints are added atomically inside dbmate's transaction
ALTER TABLE public.runs ADD CONSTRAINT runs_parent_run_id_fkey FOREIGN KEY (parent_run_id) REFERENCES public.runs(id) ON DELETE SET NULL NOT VALID;
-- squawk-ignore prefer-robust-stmts -- constraint is added atomically inside dbmate's transaction
ALTER TABLE public.runs ADD CONSTRAINT runs_parent_not_self_check CHECK (parent_run_id IS NULL OR parent_run_id <> id) NOT VALID;
-- squawk-ignore prefer-robust-stmts -- dbmate wraps the migration
ALTER TABLE public.runs VALIDATE CONSTRAINT runs_parent_run_id_fkey;
-- squawk-ignore prefer-robust-stmts -- dbmate wraps the migration
ALTER TABLE public.runs VALIDATE CONSTRAINT runs_parent_not_self_check;

-- squawk-ignore prefer-robust-stmts -- constraint is added atomically inside dbmate's transaction
ALTER TABLE public.automation_run_events ADD CONSTRAINT automation_run_events_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE CASCADE NOT VALID;
-- squawk-ignore prefer-robust-stmts -- dbmate wraps the migration
ALTER TABLE public.automation_run_events VALIDATE CONSTRAINT automation_run_events_run_id_fkey;

-- squawk-ignore prefer-robust-stmts -- constraint is added atomically inside dbmate's transaction
ALTER TABLE public.event_classifications ADD CONSTRAINT event_classifications_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.runs(id) ON DELETE SET NULL NOT VALID;
-- squawk-ignore prefer-robust-stmts -- dbmate wraps the migration
ALTER TABLE public.event_classifications VALIDATE CONSTRAINT event_classifications_run_id_fkey;

-- squawk-ignore prefer-robust-stmts -- constraint is added atomically inside dbmate's transaction
ALTER TABLE public.automation_reactions ADD CONSTRAINT automation_reactions_source_run_id_fkey FOREIGN KEY (source_run_id) REFERENCES public.runs(id) ON DELETE CASCADE NOT VALID;
-- squawk-ignore prefer-robust-stmts -- dbmate wraps the migration
ALTER TABLE public.automation_reactions VALIDATE CONSTRAINT automation_reactions_source_run_id_fkey;

-- squawk-ignore require-concurrent-index-creation -- relation is already locked by the column rename
CREATE UNIQUE INDEX IF NOT EXISTS runs_entity_change_pending_dedupe_v2
  ON public.runs (
    organization_id,
    action_key,
    COALESCE(parent_run_id, 0::bigint),
    md5(action_input::text)
  )
  WHERE run_type = 'internal'
    AND action_key IN ('entity_field_change', 'entity_change')
    AND approval_status = 'pending'
    AND status = 'pending';

COMMENT ON COLUMN public.runs.parent_run_id IS
  'Causal parent run for child actions, approvals, and internal work.';
COMMENT ON TABLE public.automation_run_events IS
  'Content events analyzed by an Automation run.';
COMMENT ON COLUMN public.automation_run_events.run_id IS
  'Automation execution that analyzed the linked event.';

-- migrate:down

-- One-way contract migration. Historical canvas_state events remain superseded
-- and append-only; the removed runtime identity is not reconstructed.
SELECT 1;
