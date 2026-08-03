-- migrate:up

-- This is an atomic vocabulary cutover. There is no compatibility view or
-- dual-write period: the application and schema move to Behavior together.
-- squawk-ignore renaming-table,prefer-robust-stmts -- intentional hard cutover; no mixed-schema clients
ALTER TABLE public.watchers RENAME TO behaviors;
-- squawk-ignore renaming-table,prefer-robust-stmts -- intentional hard cutover; no mixed-schema clients
ALTER TABLE public.watcher_versions RENAME TO behavior_versions;
-- squawk-ignore renaming-table,prefer-robust-stmts -- intentional hard cutover; no mixed-schema clients
ALTER TABLE public.watcher_reactions RENAME TO behavior_reactions;
-- squawk-ignore renaming-table,prefer-robust-stmts -- intentional hard cutover; no mixed-schema clients
ALTER TABLE public.watcher_window_events RENAME TO behavior_window_events;

-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover as the table renames
ALTER TABLE public.behaviors RENAME COLUMN source_watcher_id TO source_behavior_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover as the table renames
ALTER TABLE public.behaviors RENAME COLUMN watcher_group_id TO behavior_group_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover as the table renames
ALTER TABLE public.behavior_versions RENAME COLUMN watcher_id TO behavior_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover as the table renames
ALTER TABLE public.behavior_reactions RENAME COLUMN watcher_id TO behavior_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover as the table renames
ALTER TABLE public.behavior_window_events RENAME COLUMN watcher_id TO behavior_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover as the table renames
ALTER TABLE public.classify_facet RENAME COLUMN watcher_id TO behavior_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover as the table renames
ALTER TABLE public.entity_merge_operations RENAME COLUMN watcher_id TO behavior_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover as the table renames
ALTER TABLE public.event_classifications RENAME COLUMN watcher_id TO behavior_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover as the table renames
ALTER TABLE public.runs RENAME COLUMN watcher_id TO behavior_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- view column moves atomically with its readers
ALTER VIEW public.canvas_windows RENAME COLUMN watcher_id TO behavior_id;

-- Constraint and index identifiers do not follow table/column renames. Rename
-- them from the catalog so generated NOT NULL constraints are covered too.
DO $rename_constraints$
DECLARE
  item record;
  renamed text;
BEGIN
  FOR item IN
    SELECT con.oid, con.conname, c.relname AS table_name
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND con.conname LIKE '%watcher%'
  LOOP
    renamed := replace(replace(item.conname, 'watchers', 'behaviors'), 'watcher', 'behavior');
    EXECUTE format(
      'ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
      item.table_name,
      item.conname,
      renamed
    );
  END LOOP;
END
$rename_constraints$;

DO $rename_relations$
DECLARE
  item record;
  renamed text;
BEGIN
  FOR item IN
    SELECT c.relkind, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('i', 'S')
      AND c.relname LIKE '%watcher%'
  LOOP
    renamed := replace(replace(item.relname, 'watchers', 'behaviors'), 'watcher', 'behavior');
    IF item.relkind = 'i' THEN
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', item.relname, renamed);
    ELSE
      EXECUTE format('ALTER SEQUENCE public.%I RENAME TO %I', item.relname, renamed);
    END IF;
  END LOOP;
END
$rename_relations$;

-- The principal discriminator is live protocol state, not an internal alias.
UPDATE public.runs
SET policy_principal_kind = 'behavior'
WHERE policy_principal_kind = 'watcher';

ALTER TABLE public.runs DROP CONSTRAINT IF EXISTS runs_policy_principal_kind_check;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_policy_principal_kind_check CHECK (
    policy_principal_kind IS NULL
    OR policy_principal_kind IN ('agent', 'behavior', 'user')
  ) NOT VALID;
ALTER TABLE public.runs VALIDATE CONSTRAINT runs_policy_principal_kind_check;

-- ── Durable values, not just identifiers ────────────────────────────────────
-- Renaming a column does not rewrite the strings stored in it. Every value
-- below is matched by literal equality on a live read path, so leaving the
-- retired vocabulary in mutable configuration data silently orphans every
-- pre-cutover row:
--   * entity_identities 'watcher_key' → keyed promotion stops deduping and
--     mints a duplicate entity per Behavior window.
--   * entity_identities 'watcher_canvas' → the live-unique claim that makes
--     canvas creation multi-replica safe no longer collides.
--   * write_approval_policies principal_* → per-Behavior write policies stop
--     matching and fall back to the org default envelope.
--   * organization.metadata sentinel → every org looks un-provisioned and
--     gets a second default agent + Behavior on next sign-in.
-- They move inside the same atomic cutover as the identifiers.

UPDATE public.entity_identities SET namespace = 'behavior_canvas' WHERE namespace = 'watcher_canvas';
UPDATE public.entity_identities SET namespace = 'behavior_key' WHERE namespace = 'watcher_key';
UPDATE public.entity_identities SET source_connector = 'behavior' WHERE source_connector = 'watcher';

UPDATE public.write_approval_policies SET principal_kind = 'behavior' WHERE principal_kind = 'watcher';
UPDATE public.write_approval_policies
SET principal_id = 'behavior:' || substr(principal_id, length('watcher:') + 1)
WHERE principal_id LIKE 'watcher:%';

-- organization.metadata is TEXT holding JSON, and legacy rows may hold
-- non-JSON text (see readOrgMetadata). Parse per row so one bad row cannot
-- abort the cutover.
DO $provisioning_sentinel$
DECLARE
  org record;
  parsed jsonb;
BEGIN
  FOR org IN
    SELECT id, metadata
    FROM public."organization"
    WHERE metadata LIKE '%default_watcher_provisioned%'
  LOOP
    BEGIN
      parsed := org.metadata::jsonb;
    EXCEPTION
      WHEN others THEN CONTINUE;
    END;
    IF jsonb_typeof(parsed) <> 'object' OR NOT (parsed ? 'default_watcher_provisioned') THEN
      CONTINUE;
    END IF;
    parsed := (parsed - 'default_watcher_provisioned')
      || jsonb_build_object(
        'default_behavior_provisioned',
        parsed -> 'default_watcher_provisioned'
      );
    UPDATE public."organization" SET metadata = parsed::text WHERE id = org.id;
  END LOOP;
END
$provisioning_sentinel$;

-- Error text is mutable run state, so canonicalize it once instead of keeping
-- a read-time compatibility rewrite. The append-only events table is never
-- rewritten by this migration; historical event payloads remain history.
UPDATE public.runs
SET error_message = replace(error_message, 'client.watchers.', 'client.behaviors.')
WHERE error_message LIKE '%client.watchers.%';

-- Canvas identity is the root event id. Only its metadata vocabulary changes;
-- the event chain and window identity stay exactly the same.
-- squawk-ignore require-concurrent-index-deletion -- atomic hard cutover with no serving clients
DROP INDEX IF EXISTS public.idx_canvas_chain_root;
-- squawk-ignore require-concurrent-index-creation -- atomic hard cutover with no serving clients
CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_chain_root
  ON public.events (
    ((metadata->>'behavior_id')::bigint),
    (metadata->>'granularity'),
    (metadata->>'window_start')
  )
  WHERE semantic_type = 'canvas_state' AND supersedes_event_id IS NULL;

-- squawk-ignore require-concurrent-index-deletion -- atomic hard cutover with no serving clients
DROP INDEX IF EXISTS public.idx_canvas_state_listing;
-- squawk-ignore require-concurrent-index-creation -- atomic hard cutover with no serving clients
CREATE INDEX IF NOT EXISTS idx_canvas_state_listing
  ON public.events (
    ((metadata->>'behavior_id')::bigint),
    (metadata->>'granularity'),
    (metadata->>'window_start') DESC
  )
  WHERE semantic_type = 'canvas_state';

CREATE OR REPLACE VIEW public.canvas_windows AS
SELECT
    root.id,
    root.organization_id,
    (root.metadata->>'behavior_id')::bigint AS behavior_id,
    root.metadata->>'granularity' AS granularity,
    (root.metadata->>'window_start')::timestamptz AS window_start,
    (root.metadata->>'window_end')::timestamptz AS window_end,
    (root.metadata->>'version_id')::bigint AS version_id,
    root.created_at,
    head.payload_data AS extracted_data,
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
    AND (e.metadata->>'behavior_id')::bigint = (root.metadata->>'behavior_id')::bigint
    AND e.metadata->>'granularity' = root.metadata->>'granularity'
    AND e.metadata->>'window_start' = root.metadata->>'window_start'
    AND e.superseded_by IS NULL
  LIMIT 1
) head ON TRUE
LEFT JOIN public.runs run ON run.id = head.run_id
WHERE root.semantic_type = 'canvas_state'
  AND root.supersedes_event_id IS NULL;

CREATE OR REPLACE FUNCTION public.archive_chat_behaviors_for_deleted_connection()
RETURNS trigger
LANGUAGE plpgsql
AS $archive$
BEGIN
  UPDATE public.behaviors b
  SET status = 'archived', updated_at = current_timestamp
  WHERE b.status = 'active'
    AND b.tags @> ARRAY['system:chat-link']::text[]
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(b.triggers, '[]'::jsonb)) behavior_trigger
      WHERE behavior_trigger->>'kind' = 'event'
        AND behavior_trigger->>'connector_key' = NEW.connector_key
        AND jsonb_typeof(behavior_trigger->'connection_id') = 'number'
        AND (behavior_trigger->>'connection_id')::bigint = NEW.id
        AND behavior_trigger->'event_types' ? 'message.created'
    );
  RETURN NEW;
END
$archive$;

CREATE OR REPLACE FUNCTION public.archive_behaviors_for_deleted_agent()
RETURNS trigger
LANGUAGE plpgsql
AS $archive$
BEGIN
  UPDATE public.behaviors b
  SET status = 'archived', updated_at = current_timestamp
  WHERE b.status = 'active'
    AND b.organization_id = OLD.organization_id
    AND b.agent_id = OLD.id;
  RETURN OLD;
END
$archive$;

DROP TRIGGER IF EXISTS stamp_watcher_last_run_completed_at ON public.runs;
DROP FUNCTION IF EXISTS public.stamp_watcher_last_run_completed_at();

CREATE FUNCTION public.stamp_behavior_last_run_completed_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.behaviors
  SET last_run_completed_at = GREATEST(
    COALESCE(last_run_completed_at, NEW.completed_at),
    NEW.completed_at
  )
  WHERE id = NEW.behavior_id
    AND organization_id = NEW.organization_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stamp_behavior_last_run_completed_at
  AFTER INSERT OR UPDATE OF
    status, completed_at, behavior_id, run_type, organization_id
  ON public.runs
  FOR EACH ROW
  WHEN (
    NEW.run_type = 'behavior'
    AND NEW.status = 'completed'
    AND NEW.behavior_id IS NOT NULL
    AND NEW.completed_at IS NOT NULL
  )
  EXECUTE FUNCTION public.stamp_behavior_last_run_completed_at();

COMMENT ON TABLE public.events IS
  'Append-only event log: the primary data substrate. Each row is a discrete observation from a connector or user action. Behaviors, semantic search, and entity extraction all derive from here. Never DELETE; supersede with a tombstone row that points at the original via supersedes_event_id.';
COMMENT ON TABLE public.feeds IS
  'Per-organization content feeds derived from a connection. Behaviors and agents subscribe to feeds.';
COMMENT ON TABLE public.runs IS
  'Job queue for the gateway. Each row is one sync, action, embed_backfill, auth, behavior, chat_message, schedule, agent_run, internal, or task invocation.';
COMMENT ON TABLE public.behaviors IS
  'Per-agent autonomous Behavior definitions. Activations enqueue behavior runs; runs are the unit of execution.';
COMMENT ON COLUMN public.behaviors.execution_config IS
  'Per-Behavior device-worker CLI execution settings: timeout_seconds, max_budget_usd, model, permission_mode, and effort. NULL uses defaults.';
COMMENT ON COLUMN public.behavior_versions.reactions_guidance IS
  'Optional guidance for agents on reactions to take after analyzing a Behavior window.';
COMMENT ON COLUMN public.write_approval_policies.principal_kind IS
  'NULL is the org default. agent or behavior selects an envelope for that principal kind.';
COMMENT ON COLUMN public.write_approval_policies.principal_id IS
  'NULL with kind set means any principal of that kind; otherwise the specific agent or Behavior id. Both principal columns NULL means org default.';

-- migrate:down

-- The product deliberately has no mixed-vocabulary runtime. Roll back the
-- application before applying this reverse schema cutover.
DROP TRIGGER IF EXISTS stamp_behavior_last_run_completed_at ON public.runs;
DROP FUNCTION IF EXISTS public.stamp_behavior_last_run_completed_at();

-- squawk-ignore renaming-table,prefer-robust-stmts -- rollback hard cutover
ALTER TABLE public.behaviors RENAME TO watchers;
-- squawk-ignore renaming-table,prefer-robust-stmts -- rollback hard cutover
ALTER TABLE public.behavior_versions RENAME TO watcher_versions;
-- squawk-ignore renaming-table,prefer-robust-stmts -- rollback hard cutover
ALTER TABLE public.behavior_reactions RENAME TO watcher_reactions;
-- squawk-ignore renaming-table,prefer-robust-stmts -- rollback hard cutover
ALTER TABLE public.behavior_window_events RENAME TO watcher_window_events;

-- squawk-ignore renaming-column,prefer-robust-stmts -- rollback hard cutover
ALTER TABLE public.watchers RENAME COLUMN source_behavior_id TO source_watcher_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- rollback hard cutover
ALTER TABLE public.watchers RENAME COLUMN behavior_group_id TO watcher_group_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- rollback hard cutover
ALTER TABLE public.watcher_versions RENAME COLUMN behavior_id TO watcher_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- rollback hard cutover
ALTER TABLE public.watcher_reactions RENAME COLUMN behavior_id TO watcher_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- rollback hard cutover
ALTER TABLE public.watcher_window_events RENAME COLUMN behavior_id TO watcher_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- rollback hard cutover
ALTER TABLE public.classify_facet RENAME COLUMN behavior_id TO watcher_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- rollback hard cutover
ALTER TABLE public.entity_merge_operations RENAME COLUMN behavior_id TO watcher_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- rollback hard cutover
ALTER TABLE public.event_classifications RENAME COLUMN behavior_id TO watcher_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- rollback hard cutover
ALTER TABLE public.runs RENAME COLUMN behavior_id TO watcher_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- rollback hard cutover
ALTER VIEW public.canvas_windows RENAME COLUMN behavior_id TO watcher_id;

DO $rename_constraints$
DECLARE
  item record;
  renamed text;
BEGIN
  FOR item IN
    SELECT con.conname, c.relname AS table_name
    FROM pg_constraint con
    JOIN pg_class c ON c.oid = con.conrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname IN (
        'watchers',
        'watcher_versions',
        'watcher_reactions',
        'watcher_window_events',
        'entity_merge_operations',
        'runs'
      )
      AND con.conname LIKE '%behavior%'
  LOOP
    renamed := replace(replace(item.conname, 'behaviors', 'watchers'), 'behavior', 'watcher');
    EXECUTE format(
      'ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
      item.table_name,
      item.conname,
      renamed
    );
  END LOOP;
END
$rename_constraints$;

DO $rename_relations$
DECLARE
  item record;
  renamed text;
BEGIN
  FOR item IN
    SELECT c.relkind, c.relname
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind IN ('i', 'S')
      AND c.relname ~ '^(behavior_|behaviors_|idx_behavior_|idx_behaviors_|idx_cc_behavior_id$|idx_runs_behavior_id$)'
  LOOP
    renamed := replace(replace(item.relname, 'behaviors', 'watchers'), 'behavior', 'watcher');
    IF item.relkind = 'i' THEN
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', item.relname, renamed);
    ELSE
      EXECUTE format('ALTER SEQUENCE public.%I RENAME TO %I', item.relname, renamed);
    END IF;
  END LOOP;
END
$rename_relations$;

UPDATE public.runs
SET policy_principal_kind = 'watcher'
WHERE policy_principal_kind = 'behavior';

ALTER TABLE public.runs DROP CONSTRAINT IF EXISTS runs_policy_principal_kind_check;
ALTER TABLE public.runs
  ADD CONSTRAINT runs_policy_principal_kind_check CHECK (
    policy_principal_kind IS NULL
    OR policy_principal_kind IN ('agent', 'watcher', 'user')
  ) NOT VALID;
ALTER TABLE public.runs VALIDATE CONSTRAINT runs_policy_principal_kind_check;

-- Reverse the mutable configuration-value cutover above.
UPDATE public.entity_identities SET namespace = 'watcher_canvas' WHERE namespace = 'behavior_canvas';
UPDATE public.entity_identities SET namespace = 'watcher_key' WHERE namespace = 'behavior_key';
UPDATE public.entity_identities SET source_connector = 'watcher' WHERE source_connector = 'behavior';

UPDATE public.write_approval_policies SET principal_kind = 'watcher' WHERE principal_kind = 'behavior';
UPDATE public.write_approval_policies
SET principal_id = 'watcher:' || substr(principal_id, length('behavior:') + 1)
WHERE principal_id LIKE 'behavior:%';

DO $provisioning_sentinel$
DECLARE
  org record;
  parsed jsonb;
BEGIN
  FOR org IN
    SELECT id, metadata
    FROM public."organization"
    WHERE metadata LIKE '%default_behavior_provisioned%'
  LOOP
    BEGIN
      parsed := org.metadata::jsonb;
    EXCEPTION
      WHEN others THEN CONTINUE;
    END;
    IF jsonb_typeof(parsed) <> 'object' OR NOT (parsed ? 'default_behavior_provisioned') THEN
      CONTINUE;
    END IF;
    parsed := (parsed - 'default_behavior_provisioned')
      || jsonb_build_object(
        'default_watcher_provisioned',
        parsed -> 'default_behavior_provisioned'
      );
    UPDATE public."organization" SET metadata = parsed::text WHERE id = org.id;
  END LOOP;
END
$provisioning_sentinel$;

-- squawk-ignore require-concurrent-index-deletion -- rollback hard cutover
DROP INDEX IF EXISTS public.idx_canvas_chain_root;
-- squawk-ignore require-concurrent-index-creation -- rollback hard cutover
CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_chain_root
  ON public.events (
    ((metadata->>'watcher_id')::bigint),
    (metadata->>'granularity'),
    (metadata->>'window_start')
  )
  WHERE semantic_type = 'canvas_state' AND supersedes_event_id IS NULL;

-- squawk-ignore require-concurrent-index-deletion -- rollback hard cutover
DROP INDEX IF EXISTS public.idx_canvas_state_listing;
-- squawk-ignore require-concurrent-index-creation -- rollback hard cutover
CREATE INDEX IF NOT EXISTS idx_canvas_state_listing
  ON public.events (
    ((metadata->>'watcher_id')::bigint),
    (metadata->>'granularity'),
    (metadata->>'window_start') DESC
  )
  WHERE semantic_type = 'canvas_state';

CREATE OR REPLACE VIEW public.canvas_windows AS
SELECT
    root.id,
    root.organization_id,
    (root.metadata->>'watcher_id')::bigint AS watcher_id,
    root.metadata->>'granularity' AS granularity,
    (root.metadata->>'window_start')::timestamptz AS window_start,
    (root.metadata->>'window_end')::timestamptz AS window_end,
    (root.metadata->>'version_id')::bigint AS version_id,
    root.created_at,
    head.payload_data AS extracted_data,
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
    AND e.metadata->>'granularity' = root.metadata->>'granularity'
    AND e.metadata->>'window_start' = root.metadata->>'window_start'
    AND e.superseded_by IS NULL
  LIMIT 1
) head ON TRUE
LEFT JOIN public.runs run ON run.id = head.run_id
WHERE root.semantic_type = 'canvas_state'
  AND root.supersedes_event_id IS NULL;

CREATE OR REPLACE FUNCTION public.archive_chat_behaviors_for_deleted_connection()
RETURNS trigger
LANGUAGE plpgsql
AS $archive$
BEGIN
  UPDATE public.watchers w
  SET status = 'archived', updated_at = current_timestamp
  WHERE w.status = 'active'
    AND w.tags @> ARRAY['system:chat-link']::text[]
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(w.triggers, '[]'::jsonb)) behavior_trigger
      WHERE behavior_trigger->>'kind' = 'event'
        AND behavior_trigger->>'connector_key' = NEW.connector_key
        AND jsonb_typeof(behavior_trigger->'connection_id') = 'number'
        AND (behavior_trigger->>'connection_id')::bigint = NEW.id
        AND behavior_trigger->'event_types' ? 'message.created'
    );
  RETURN NEW;
END
$archive$;

CREATE OR REPLACE FUNCTION public.archive_behaviors_for_deleted_agent()
RETURNS trigger
LANGUAGE plpgsql
AS $archive$
BEGIN
  UPDATE public.watchers w
  SET status = 'archived', updated_at = current_timestamp
  WHERE w.status = 'active'
    AND w.organization_id = OLD.organization_id
    AND w.agent_id = OLD.id;
  RETURN OLD;
END
$archive$;

CREATE FUNCTION public.stamp_watcher_last_run_completed_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.watchers
  SET last_run_completed_at = GREATEST(
    COALESCE(last_run_completed_at, NEW.completed_at),
    NEW.completed_at
  )
  WHERE id = NEW.watcher_id
    AND organization_id = NEW.organization_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stamp_watcher_last_run_completed_at
  AFTER INSERT OR UPDATE OF
    status, completed_at, watcher_id, run_type, organization_id
  ON public.runs
  FOR EACH ROW
  WHEN (
    NEW.run_type = 'behavior'
    AND NEW.status = 'completed'
    AND NEW.watcher_id IS NOT NULL
    AND NEW.completed_at IS NOT NULL
  )
  EXECUTE FUNCTION public.stamp_watcher_last_run_completed_at();

COMMENT ON TABLE public.events IS
  'Append-only event log: the primary data substrate. Each row is a discrete observation from a connector or user action. Watchers, semantic search, and entity extraction all derive from here. Never DELETE; supersede with a tombstone row that points at the original via supersedes_event_id.';
COMMENT ON TABLE public.feeds IS
  'Per-organization content feeds derived from a connection. Watchers and agents subscribe to feeds.';
COMMENT ON TABLE public.runs IS
  'Job queue for the gateway. Each row is one sync, action, embed_backfill, auth, behavior, chat_message, schedule, agent_run, internal, or task invocation.';
COMMENT ON TABLE public.watchers IS
  'Per-agent autonomous Behavior definitions. Activations enqueue behavior runs; runs are the unit of execution.';
COMMENT ON COLUMN public.watchers.execution_config IS
  'Per-Behavior device-worker CLI execution settings: timeout_seconds, max_budget_usd, model, permission_mode, and effort. NULL uses defaults.';
COMMENT ON COLUMN public.watcher_versions.reactions_guidance IS
  'Optional guidance for agents on reactions to take after analyzing a Behavior window.';
COMMENT ON COLUMN public.write_approval_policies.principal_kind IS
  'NULL is the org default. agent or watcher selects an envelope for that principal kind.';
COMMENT ON COLUMN public.write_approval_policies.principal_id IS
  'NULL with kind set means any principal of that kind; otherwise the specific agent or watcher id. Both principal columns NULL means org default.';
