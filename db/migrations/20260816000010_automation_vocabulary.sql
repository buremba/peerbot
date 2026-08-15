-- migrate:up

-- Version 20260816000010 follows the ACL cleanup migration merged during the cutover.

-- One atomic breaking cutover. The Helm migration hook scales every application
-- and worker replica to zero before this file runs, so there is no mixed-schema
-- window and no compatibility view, alias, or dual-write period.

DROP TRIGGER IF EXISTS archive_behaviors_for_deleted_agent ON public.agents;
DROP TRIGGER IF EXISTS archive_chat_behaviors_for_deleted_connection ON public.connections;
DROP TRIGGER IF EXISTS stamp_watcher_last_run_completed_at ON public.runs;
DROP FUNCTION IF EXISTS public.archive_behaviors_for_deleted_agent();
DROP FUNCTION IF EXISTS public.archive_chat_behaviors_for_deleted_connection();
DROP FUNCTION IF EXISTS public.stamp_watcher_last_run_completed_at();

-- connector-trait-merge-strategy:start
-- The published connector contract now calls the trait merge policy
-- `mergeStrategy`. Rewrite the two durable JSON snapshots that can outlive the
-- connector source that produced them. This is a hard cutover: application code
-- reads only the new key.
CREATE OR REPLACE FUNCTION pg_temp.rename_connector_trait_merge_strategy(node jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  rewritten jsonb;
  entry_key text;
  entry_value jsonb;
BEGIN
  CASE jsonb_typeof(node)
    WHEN 'object' THEN
      rewritten := '{}'::jsonb;
      FOR entry_key, entry_value IN SELECT key, value FROM jsonb_each(node) LOOP
        IF entry_key = 'behavior'
          AND jsonb_typeof(entry_value) = 'string'
          AND entry_value #>> '{}' IN ('init_only', 'prefer_non_empty', 'overwrite')
        THEN
          IF NOT (node ? 'mergeStrategy') THEN
            rewritten := rewritten || jsonb_build_object('mergeStrategy', entry_value);
          END IF;
        ELSE
          rewritten := rewritten || jsonb_build_object(
            entry_key,
            pg_temp.rename_connector_trait_merge_strategy(entry_value)
          );
        END IF;
      END LOOP;
      RETURN rewritten;
    WHEN 'array' THEN
      SELECT COALESCE(
        jsonb_agg(
          pg_temp.rename_connector_trait_merge_strategy(item.value)
          ORDER BY item.ordinality
        ),
        '[]'::jsonb
      )
      INTO rewritten
      FROM jsonb_array_elements(node) WITH ORDINALITY AS item(value, ordinality);
      RETURN rewritten;
    ELSE
      RETURN node;
  END CASE;
END;
$$;

UPDATE public.connector_definitions
SET feeds_schema = pg_temp.rename_connector_trait_merge_strategy(feeds_schema),
    updated_at = current_timestamp
WHERE feeds_schema::text ~
  '"behavior"[[:space:]]*:[[:space:]]*"(init_only|prefer_non_empty|overwrite)"';

UPDATE public.device_workers
SET connector_manifests =
  pg_temp.rename_connector_trait_merge_strategy(connector_manifests)
WHERE connector_manifests::text ~
  '"behavior"[[:space:]]*:[[:space:]]*"(init_only|prefer_non_empty|overwrite)"';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.connector_definitions
    WHERE feeds_schema::text ~
      '"behavior"[[:space:]]*:[[:space:]]*"(init_only|prefer_non_empty|overwrite)"'
  ) OR EXISTS (
    SELECT 1
    FROM public.device_workers
    WHERE connector_manifests::text ~
      '"behavior"[[:space:]]*:[[:space:]]*"(init_only|prefer_non_empty|overwrite)"'
  ) THEN
    RAISE EXCEPTION 'connector trait merge-strategy cutover left a retired key';
  END IF;
END $$;
-- connector-trait-merge-strategy:end

ALTER TABLE public.runs DROP CONSTRAINT IF EXISTS runs_run_type_check;
ALTER TABLE public.runs DROP CONSTRAINT IF EXISTS runs_legacy_org_required;
ALTER TABLE public.runs DROP CONSTRAINT IF EXISTS runs_policy_principal_kind_check;

UPDATE public.runs
SET run_type = CASE run_type
  WHEN 'behavior' THEN 'automation'
  WHEN 'behavior_eval' THEN 'automation_eval'
  ELSE run_type
END
WHERE run_type IN ('behavior', 'behavior_eval');

UPDATE public.runs
SET policy_principal_kind = 'automation'
WHERE policy_principal_kind IN ('watcher', 'behavior');

UPDATE public.runs
SET policy_principal_id = regexp_replace(
  policy_principal_id,
  '^(watcher|behavior):',
  'automation:'
)
WHERE policy_principal_id ~ '^(watcher|behavior):';

UPDATE public.entity_identities
SET namespace = CASE namespace
  WHEN 'watcher_canvas' THEN 'automation_canvas'
  WHEN 'behavior_canvas' THEN 'automation_canvas'
  WHEN 'watcher_key' THEN 'automation_key'
  WHEN 'behavior_key' THEN 'automation_key'
  ELSE namespace
END
WHERE namespace IN ('watcher_canvas', 'behavior_canvas', 'watcher_key', 'behavior_key');

UPDATE public.entity_identities
SET source_connector = 'automation'
WHERE source_connector IN ('watcher', 'behavior');

UPDATE public.write_approval_policies
SET principal_kind = 'automation'
WHERE principal_kind IN ('watcher', 'behavior');

UPDATE public.write_approval_policies
SET principal_id = regexp_replace(principal_id, '^(watcher|behavior):', 'automation:')
WHERE principal_id ~ '^(watcher|behavior):';

-- entity-metadata-cutover:start
-- Entity metadata is user-extensible. Only rewrite rows whose live identity
-- proves they belong to the Automation canvas/key protocols; exact-looking
-- keys on ordinary entities are customer data and must remain untouched.
UPDATE public.entities AS entity
SET metadata = (metadata - 'watcher_id' - 'behavior_id')
  || jsonb_build_object(
    'automation_id',
    COALESCE(metadata->'automation_id', metadata->'behavior_id', metadata->'watcher_id')
  )
WHERE (metadata ? 'watcher_id' OR metadata ? 'behavior_id')
  AND EXISTS (
    SELECT 1
    FROM public.entity_identities identity
    WHERE identity.entity_id = entity.id
      AND identity.deleted_at IS NULL
      AND identity.namespace IN ('automation_canvas', 'automation_key')
  );

UPDATE public.entities AS entity
SET metadata = jsonb_set(metadata, '{source}', '"automation_canvas"'::jsonb)
WHERE metadata->>'source' IN ('watcher_canvas', 'behavior_canvas')
  AND EXISTS (
    SELECT 1
    FROM public.entity_identities identity
    WHERE identity.entity_id = entity.id
      AND identity.deleted_at IS NULL
      AND identity.namespace = 'automation_canvas'
  );

UPDATE public.entities AS entity
SET metadata = jsonb_set(metadata, '{source}', '"automation_promotion"'::jsonb)
WHERE metadata->>'source' IN ('watcher_promotion', 'behavior_promotion')
  AND EXISTS (
    SELECT 1
    FROM public.entity_identities identity
    WHERE identity.entity_id = entity.id
      AND identity.deleted_at IS NULL
      AND identity.namespace = 'automation_key'
  );

UPDATE public.entities AS entity
SET metadata = jsonb_set(metadata, '{resourceKind}', '"automation"'::jsonb)
WHERE metadata->>'resourceKind' IN ('watcher', 'behavior')
  AND EXISTS (
    SELECT 1
    FROM public.entity_identities identity
    WHERE identity.entity_id = entity.id
      AND identity.deleted_at IS NULL
      AND identity.namespace IN ('automation_canvas', 'automation_key')
  );

UPDATE public.entities AS entity
SET metadata = jsonb_set(metadata, '{resource_kind}', '"automation"'::jsonb)
WHERE metadata->>'resource_kind' IN ('watcher', 'behavior')
  AND EXISTS (
    SELECT 1
    FROM public.entity_identities identity
    WHERE identity.entity_id = entity.id
      AND identity.deleted_at IS NULL
      AND identity.namespace IN ('automation_canvas', 'automation_key')
  );
-- entity-metadata-cutover:end

-- User-authored SQL, prompts, templates, scripts, error text, and arbitrary JSON
-- are data rather than vocabulary-bearing contracts. Preserve them byte-for-byte:
-- a global text replacement could corrupt an external column, quoted prose, or
-- opaque connector payload. Typed columns and exact reserved values are migrated
-- explicitly above; no alias is installed for authored references to retired
-- physical relations.

-- Events are append-only. Their authored payloads and JSON are intentionally
-- never updated. The two attribution columns below are metadata-only catalog
-- renames and preserve every stored value and event id.

-- squawk-ignore renaming-table,prefer-robust-stmts -- intentional quiesced hard cutover
ALTER TABLE public.watchers RENAME TO automations;
-- squawk-ignore renaming-table,prefer-robust-stmts -- intentional quiesced hard cutover
ALTER TABLE public.watcher_versions RENAME TO automation_versions;
-- squawk-ignore renaming-table,prefer-robust-stmts -- intentional quiesced hard cutover
ALTER TABLE public.watcher_reactions RENAME TO automation_reactions;
-- squawk-ignore renaming-table,prefer-robust-stmts -- intentional quiesced hard cutover
ALTER TABLE public.watcher_window_events RENAME TO automation_window_events;

-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover
ALTER TABLE public.automations RENAME COLUMN source_watcher_id TO source_automation_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover
ALTER TABLE public.automations RENAME COLUMN watcher_group_id TO automation_group_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover
ALTER TABLE public.automation_versions RENAME COLUMN watcher_id TO automation_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover
ALTER TABLE public.automation_reactions RENAME COLUMN watcher_id TO automation_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover
ALTER TABLE public.automation_window_events RENAME COLUMN watcher_id TO automation_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover
ALTER TABLE public.classify_facet RENAME COLUMN watcher_id TO automation_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover
ALTER TABLE public.entity_merge_operations RENAME COLUMN watcher_id TO automation_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover
ALTER TABLE public.event_classifications RENAME COLUMN watcher_id TO automation_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover
ALTER TABLE public.runs RENAME COLUMN watcher_id TO automation_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover
ALTER TABLE public.events RENAME COLUMN behavior_id TO automation_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover
ALTER TABLE public.events RENAME COLUMN behavior_version_id TO automation_version_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover
ALTER TABLE public.connector_definitions RENAME COLUMN behavior_events TO automation_events;

-- automation-event-identity-bridge:start
-- Keyed Automation output heads written before the cutover use the retired
-- identity namespace. Extend each live chain with a canonical successor so the
-- new writer discovers and supersedes it without mutating authored history.
-- The predecessor receives only the normal same-transaction lineage stamp.
-- Strip the reserved idempotency marker from the successor because its
-- organization-scoped unique index deliberately continues to resolve retries
-- to the original write.
WITH canonical_heads AS (
  INSERT INTO public.events (
    organization_id, entity_ids, origin_id, title,
    payload_type, payload_text, payload_data, payload_template, attachments, metadata,
    score, author_name, source_url, occurred_at, created_at, origin_parent_id, origin_type,
    connector_key, connection_id, feed_key, feed_id, run_id,
    automation_id, automation_version_id,
    semantic_type, client_id, created_by,
    interaction_type, interaction_status, interaction_input_schema, interaction_input,
    interaction_output, interaction_error, supersedes_event_id,
    identity_ns, identity_key, linked_org_ids
  )
  SELECT
    legacy.organization_id, legacy.entity_ids, legacy.origin_id, legacy.title,
    legacy.payload_type, legacy.payload_text, legacy.payload_data, legacy.payload_template,
    legacy.attachments, legacy.metadata - '_lobu_idempotency_key',
    legacy.score, legacy.author_name, legacy.source_url, legacy.occurred_at,
    legacy.created_at, legacy.origin_parent_id, legacy.origin_type,
    legacy.connector_key, legacy.connection_id, legacy.feed_key, legacy.feed_id, legacy.run_id,
    legacy.automation_id, legacy.automation_version_id,
    legacy.semantic_type, legacy.client_id, legacy.created_by,
    legacy.interaction_type, legacy.interaction_status, legacy.interaction_input_schema,
    legacy.interaction_input, legacy.interaction_output, legacy.interaction_error,
    legacy.id, 'automation_event', legacy.identity_key, legacy.linked_org_ids
  FROM public.events AS legacy
  WHERE legacy.identity_ns = 'behavior_event'
    AND legacy.identity_key IS NOT NULL
    AND legacy.superseded_by IS NULL
  RETURNING id, supersedes_event_id
)
UPDATE public.events AS legacy
SET superseded_by = canonical.id
FROM canonical_heads AS canonical
WHERE legacy.id = canonical.supersedes_event_id;

-- Preserve semantic-search coverage for the canonical successor. The bridge is
-- idempotent: after the first statement there is no live retired head, and the
-- embedding primary key makes this copy safe to replay in an isolated fixture.
INSERT INTO public.event_embeddings (
  event_id, chunk_index, embedding, embedding_model, created_at
)
SELECT
  canonical.id, embedding.chunk_index, embedding.embedding,
  embedding.embedding_model, embedding.created_at
FROM public.events AS canonical
JOIN public.events AS legacy ON legacy.id = canonical.supersedes_event_id
JOIN public.event_embeddings AS embedding ON embedding.event_id = legacy.id
WHERE canonical.identity_ns = 'automation_event'
  AND legacy.identity_ns = 'behavior_event'
ON CONFLICT (event_id, embedding_model, chunk_index) DO NOTHING;
-- automation-event-identity-bridge:end

-- Views retain their output-column names across underlying relation renames.
-- Rename those output contracts explicitly, then replace the canvas view so
-- ownership comes from the preserved physical attribution column.
-- squawk-ignore renaming-table,prefer-robust-stmts -- same atomic cutover
ALTER VIEW public.behavior_message_subscriptions RENAME TO automation_message_subscriptions;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover
ALTER VIEW public.automation_message_subscriptions RENAME COLUMN behavior_id TO automation_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover
ALTER VIEW public.current_event_records RENAME COLUMN behavior_id TO automation_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover
ALTER VIEW public.current_event_records RENAME COLUMN behavior_version_id TO automation_version_id;
-- squawk-ignore renaming-column,prefer-robust-stmts -- same atomic cutover
ALTER VIEW public.canvas_windows RENAME COLUMN watcher_id TO automation_id;

-- squawk-ignore require-concurrent-index-deletion -- replicas are quiesced
DROP INDEX IF EXISTS public.idx_canvas_chain_root;
-- squawk-ignore require-concurrent-index-deletion -- replicas are quiesced
DROP INDEX IF EXISTS public.idx_canvas_state_listing;
-- squawk-ignore require-concurrent-index-creation -- replicas are quiesced
CREATE UNIQUE INDEX IF NOT EXISTS idx_canvas_chain_root
  ON public.events (
    automation_id,
    (metadata->>'granularity'),
    (metadata->>'window_start')
  )
  WHERE semantic_type = 'canvas_state'
    AND supersedes_event_id IS NULL
    AND automation_id IS NOT NULL;
-- squawk-ignore require-concurrent-index-creation -- replicas are quiesced
CREATE INDEX IF NOT EXISTS idx_canvas_state_listing
  ON public.events (
    automation_id,
    (metadata->>'granularity'),
    (metadata->>'window_start') DESC
  )
  WHERE semantic_type = 'canvas_state' AND automation_id IS NOT NULL;

-- Partial-index predicates store literal protocol values; relation and column
-- renames cannot update them. Rebuild the four affected indexes against the
-- canonical values while replicas are stopped.
-- squawk-ignore require-concurrent-index-deletion -- replicas are quiesced
DROP INDEX IF EXISTS public.idx_events_identity_root_behavior;
-- squawk-ignore require-concurrent-index-deletion -- replicas are quiesced
DROP INDEX IF EXISTS public.idx_events_identity_head_behavior;
-- squawk-ignore require-concurrent-index-deletion -- replicas are quiesced
DROP INDEX IF EXISTS public.idx_runs_executing_per_behavior;
-- squawk-ignore require-concurrent-index-deletion -- replicas are quiesced
DROP INDEX IF EXISTS public.idx_runs_pending_non_event_per_behavior;

-- squawk-ignore require-concurrent-index-creation -- replicas are quiesced
CREATE UNIQUE INDEX IF NOT EXISTS idx_events_identity_root_automation
  ON public.events (organization_id, identity_key)
  WHERE supersedes_event_id IS NULL
    AND identity_key IS NOT NULL
    AND identity_ns = 'automation_event';
-- squawk-ignore require-concurrent-index-creation -- replicas are quiesced
CREATE INDEX IF NOT EXISTS idx_events_identity_head_automation
  ON public.events (organization_id, identity_key)
  WHERE superseded_by IS NULL
    AND identity_key IS NOT NULL
    AND identity_ns = 'automation_event';
-- squawk-ignore require-concurrent-index-creation -- replicas are quiesced
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_executing_per_automation
  ON public.runs (automation_id)
  WHERE run_type = 'automation'
    AND automation_id IS NOT NULL
    AND status IN ('claimed', 'running');
-- squawk-ignore require-concurrent-index-creation -- replicas are quiesced
CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_pending_non_event_per_automation
  ON public.runs (automation_id)
  WHERE run_type = 'automation'
    AND automation_id IS NOT NULL
    AND status = 'pending'
    AND COALESCE(approved_input->>'dispatch_source', 'scheduled') <> 'event';

CREATE OR REPLACE VIEW public.canvas_windows AS
SELECT
  root.id,
  root.organization_id,
  root.automation_id::bigint AS automation_id,
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
    AND e.automation_id = root.automation_id
    AND e.metadata->>'granularity' = root.metadata->>'granularity'
    AND e.metadata->>'window_start' = root.metadata->>'window_start'
    AND e.superseded_by IS NULL
  LIMIT 1
) head ON TRUE
LEFT JOIN public.runs run ON run.id = head.run_id
WHERE root.semantic_type = 'canvas_state'
  AND root.supersedes_event_id IS NULL
  AND root.automation_id IS NOT NULL;

ALTER TABLE public.runs
  ADD CONSTRAINT runs_run_type_check CHECK (
    run_type = ANY (ARRAY[
      'sync'::text, 'action'::text, 'embed_backfill'::text,
      'automation'::text, 'automation_eval'::text,
      'auth'::text, 'chat_message'::text,
      'schedule'::text, 'agent_run'::text, 'internal'::text, 'task'::text
    ])
  ) NOT VALID;
ALTER TABLE public.runs VALIDATE CONSTRAINT runs_run_type_check;

ALTER TABLE public.runs
  ADD CONSTRAINT runs_legacy_org_required CHECK (
    (run_type <> ALL (ARRAY[
      'sync'::text, 'action'::text, 'embed_backfill'::text,
      'automation'::text, 'auth'::text
    ])) OR organization_id IS NOT NULL
  ) NOT VALID;
ALTER TABLE public.runs VALIDATE CONSTRAINT runs_legacy_org_required;

ALTER TABLE public.runs
  ADD CONSTRAINT runs_policy_principal_kind_check CHECK (
    policy_principal_kind IS NULL
    OR policy_principal_kind IN ('agent', 'automation', 'user')
  ) NOT VALID;
ALTER TABLE public.runs VALIDATE CONSTRAINT runs_policy_principal_kind_check;

CREATE OR REPLACE FUNCTION public.archive_chat_automations_for_deleted_connection()
RETURNS trigger
LANGUAGE plpgsql
AS $archive$
BEGIN
  UPDATE public.automations automation
  SET status = 'archived', updated_at = current_timestamp
  WHERE automation.status = 'active'
    AND automation.tags @> ARRAY['system:chat-link']::text[]
    AND EXISTS (
      SELECT 1
      FROM jsonb_array_elements(COALESCE(automation.triggers, '[]'::jsonb)) automation_trigger
      WHERE automation_trigger->>'kind' = 'event'
        AND automation_trigger->>'connector_key' = NEW.connector_key
        AND jsonb_typeof(automation_trigger->'connection_id') = 'number'
        AND (automation_trigger->>'connection_id')::bigint = NEW.id
        AND automation_trigger->'event_types' ? 'message.created'
    );
  RETURN NEW;
END
$archive$;

CREATE TRIGGER archive_chat_automations_for_deleted_connection
AFTER UPDATE OF deleted_at ON public.connections
FOR EACH ROW
WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION public.archive_chat_automations_for_deleted_connection();

CREATE OR REPLACE FUNCTION public.archive_automations_for_deleted_agent()
RETURNS trigger
LANGUAGE plpgsql
AS $archive$
BEGIN
  UPDATE public.automations automation
  SET status = 'archived', updated_at = current_timestamp
  WHERE automation.status = 'active'
    AND automation.organization_id = OLD.organization_id
    AND automation.agent_id = OLD.id;
  RETURN OLD;
END
$archive$;

CREATE TRIGGER archive_automations_for_deleted_agent
AFTER DELETE ON public.agents
FOR EACH ROW
EXECUTE FUNCTION public.archive_automations_for_deleted_agent();

CREATE OR REPLACE FUNCTION public.stamp_automation_last_run_completed_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.automations
  SET last_run_completed_at = GREATEST(
    COALESCE(last_run_completed_at, NEW.completed_at),
    NEW.completed_at
  )
  WHERE id = NEW.automation_id
    AND organization_id = NEW.organization_id;
  RETURN NEW;
END;
$$;

CREATE TRIGGER stamp_automation_last_run_completed_at
  AFTER INSERT OR UPDATE OF
    status, completed_at, automation_id, run_type, organization_id
  ON public.runs
  FOR EACH ROW
  WHEN (
    NEW.run_type = 'automation'
    AND NEW.status = 'completed'
    AND NEW.automation_id IS NOT NULL
    AND NEW.completed_at IS NOT NULL
  )
  EXECUTE FUNCTION public.stamp_automation_last_run_completed_at();

-- Constraint, index, and sequence identifiers do not follow every table or
-- column rename. Canonicalize their catalog names after all structural edits.
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
    WHERE n.nspname = 'public' AND con.conname ~ '(watcher|behavior)'
  LOOP
    renamed := replace(replace(replace(replace(
      item.conname,
      'watchers', 'automations'),
      'behaviors', 'automations'),
      'watcher', 'automation'),
      'behavior', 'automation');
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
      AND c.relname ~ '(watcher|behavior)'
  LOOP
    renamed := replace(replace(replace(replace(
      item.relname,
      'watchers', 'automations'),
      'behaviors', 'automations'),
      'watcher', 'automation'),
      'behavior', 'automation');
    IF item.relkind = 'i' THEN
      EXECUTE format('ALTER INDEX public.%I RENAME TO %I', item.relname, renamed);
    ELSE
      EXECUTE format('ALTER SEQUENCE public.%I RENAME TO %I', item.relname, renamed);
    END IF;
  END LOOP;
END
$rename_relations$;

COMMENT ON TABLE public.events IS
  'Append-only event log: the primary data substrate. Each row is a discrete observation from a connector or user action. Automations, semantic search, and entity extraction all derive from here. Never DELETE; supersede with a tombstone row that points at the original via supersedes_event_id.';
COMMENT ON COLUMN public.events.automation_id IS
  'The Automation that produced this row. Provenance only; nullable for non-Automation events.';
COMMENT ON COLUMN public.events.automation_version_id IS
  'The Automation version that produced this row, so output quality can be attributed to a prompt version.';
COMMENT ON COLUMN public.events.identity_ns IS
  'Stable identity namespace within a connection or Automation source.';
COMMENT ON TABLE public.feeds IS
  'Per-organization content feeds derived from a connection. Automations and agents subscribe to feeds.';
COMMENT ON TABLE public.runs IS
  'Job queue for the gateway. Each row is one sync, action, embed_backfill, auth, automation, automation_eval, chat_message, schedule, agent_run, internal, or task invocation.';
COMMENT ON TABLE public.automations IS
  'Per-agent autonomous Automation definitions. Activations enqueue automation runs; runs are the unit of execution.';
COMMENT ON COLUMN public.automations.triggers IS
  'Automation activation definitions.';
COMMENT ON COLUMN public.automations.execution_config IS
  'Per-Automation device-worker CLI execution settings. NULL uses defaults.';
COMMENT ON COLUMN public.automations.delivery_target IS
  'Strict bound chat destination for Automation notifications: {connection_id, channel_id}. NULL keeps org-wide delivery.';
COMMENT ON COLUMN public.automations.latest_eval_run_id IS
  'The automation_eval run that produced latest_eval_score. Deliberately no FK because runs are prunable.';
COMMENT ON COLUMN public.automation_versions.outputs IS
  'Structured outputs declared by this Automation version.';
COMMENT ON COLUMN public.automation_versions.reactions_guidance IS
  'Optional guidance for agents on reactions after analyzing an Automation window.';
COMMENT ON COLUMN public.connector_definitions.automation_events IS
  'Automation event definitions emitted by this connector.';
COMMENT ON COLUMN public.write_approval_policies.principal_kind IS
  'NULL is the organization default; agent or automation selects a principal kind.';
COMMENT ON COLUMN public.write_approval_policies.principal_id IS
  'NULL with kind set means any principal of that kind; otherwise the specific agent or Automation id.';

-- migrate:down

-- This cutover intentionally has no compatibility contract. A reverse SQL
-- migration would have to teach an old application about new append-only event
-- metadata written after rollout, which is exactly the dual-vocabulary state
-- this change removes. Roll back the release by restoring its pre-migration
-- database backup and matching application image; fail closed if someone tries
-- to run `down` against live state.
DO $irreversible_cutover$
BEGIN
  RAISE EXCEPTION
    'automation vocabulary cutover is irreversible; restore the pre-migration backup';
END
$irreversible_cutover$;
