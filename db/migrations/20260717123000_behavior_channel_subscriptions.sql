-- migrate:up

-- Clean cut: channel subscriptions become Behaviors. One-shot backfill from
-- agent_channel_bindings into tagged Behaviors, install the read view, keep a
-- DB archive trigger for connection soft-delete, then DROP the legacy table.
-- No dual-write bridge — all pods must run Behavior-only code after this lands.
-- Operational cost: O(agent_channel_bindings) under a write lock.

-- Historical Slack Grid rows could contain an enterprise id (E...) where a
-- concrete workspace id (T...) belongs. Heal from the durable channel transcript
-- when possible and otherwise leave it unknown so the first inbound message can
-- fill it. This absorbs the old supervised PR1-data-reconcile.sql into the
-- automatic migration before the source table is retired.
DO $migration$
DECLARE
  binding record;
  watcher_id integer;
  version_id integer;
  created_by_user text;
  native_channel_id text;
  behavior_trigger jsonb;
BEGIN
  -- Replay-safe: after the clean-cut DROP below, re-running this section is a no-op.
  IF to_regclass('public.agent_channel_bindings') IS NULL THEN
    RETURN;
  END IF;

  -- Hold writers for the duration of the one-shot backfill so no binding lands
  -- between the snapshot and the table drop below.
  LOCK TABLE agent_channel_bindings IN SHARE ROW EXCLUSIVE MODE;

  -- Share the canonical runtime allocator locks while deriving MAX(id)+1.
  PERFORM pg_advisory_xact_lock(hashtext('watchers_id_alloc'));
  PERFORM pg_advisory_xact_lock(hashtext('watcher_versions_id_alloc'));

WITH real_team AS (
  SELECT DISTINCT ON (cm.organization_id, cm.connection_id, cm.channel_id)
    cm.organization_id,
    cm.connection_id,
    cm.channel_id,
    cm.team_id
  FROM channel_messages cm
  WHERE cm.platform LIKE 'slack%'
    AND cm.team_id ~ '^T'
  ORDER BY
    cm.organization_id,
    cm.connection_id,
    cm.channel_id,
    cm.occurred_at DESC
)
UPDATE agent_channel_bindings b
SET team_id = real_team.team_id
FROM real_team, connections c
WHERE b.platform LIKE 'slack%'
  AND b.team_id IS NOT NULL
  AND b.team_id !~ '^T'
  AND c.id = b.connection_id
  AND c.connector_key = b.platform
  AND real_team.organization_id = b.organization_id
  AND (
    c.slug = real_team.connection_id
    OR c.slug = 'agentconn-' || real_team.connection_id
  )
  AND (
    b.channel_id = real_team.channel_id
    OR b.channel_id = 'slack:' || real_team.channel_id
    OR 'slack:' || b.channel_id = real_team.channel_id
  );

UPDATE agent_channel_bindings
SET team_id = NULL
WHERE platform LIKE 'slack%'
  AND team_id IS NOT NULL
  AND team_id !~ '^T';

  IF EXISTS (
    SELECT 1
    FROM agent_channel_bindings
    WHERE connection_id IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot migrate channel subscriptions: at least one legacy binding has no concrete connection_id';
  END IF;

  FOR binding IN
    SELECT
      b.organization_id,
      b.agent_id,
      b.platform,
      b.channel_id,
      b.team_id,
      b.connection_id,
      b.model,
      b.created_at
    FROM agent_channel_bindings b
    JOIN connections c
      ON c.id = b.connection_id
     AND c.deleted_at IS NULL
    WHERE b.connection_id IS NOT NULL
    ORDER BY b.created_at, b.organization_id, b.agent_id
  LOOP
    native_channel_id := CASE
      WHEN binding.channel_id LIKE binding.platform || ':%'
        THEN substring(binding.channel_id FROM length(binding.platform) + 2)
      ELSE binding.channel_id
    END;

    -- A matching Behavior may already have been created through the new UI
    -- during a rolling deploy. Never duplicate it during the backfill.
    IF EXISTS (
      SELECT 1
      FROM watchers w
      CROSS JOIN LATERAL jsonb_array_elements(w.triggers) trigger
      WHERE w.status = 'active'
        AND w.organization_id = binding.organization_id
        AND w.agent_id = binding.agent_id
        AND w.tags @> ARRAY['system:chat-link']::text[]
        AND trigger->>'kind' = 'event'
        AND trigger->>'connector_key' = binding.platform
        AND trigger->>'connection_id' = binding.connection_id::text
        AND trigger->'event_types' = '["message.created"]'::jsonb
        AND trigger->'match'->>'channel_id' = native_channel_id
        AND (trigger->'match'->>'team_id') IS NOT DISTINCT FROM binding.team_id
        AND trigger->>'execution' = 'turn'
        AND trigger->>'active_run' = 'steer'
        AND trigger->>'output' = 'reply_to_source'
        AND trigger->'skip_if_unchanged' = 'false'::jsonb
    ) THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(
      (
        SELECT a.owner_user_id
        FROM agents a
        JOIN "user" u ON u.id = a.owner_user_id
        WHERE a.organization_id = binding.organization_id
          AND a.id = binding.agent_id
          AND a.owner_user_id IS NOT NULL
        LIMIT 1
      ),
      (
        SELECT m."userId"
        FROM member m
        JOIN "user" u ON u.id = m."userId"
        WHERE m."organizationId" = binding.organization_id
        ORDER BY m."createdAt", m.id
        LIMIT 1
      )
    ) INTO created_by_user;

    IF created_by_user IS NULL THEN
      RAISE EXCEPTION
        'Cannot migrate channel subscription %.%/%: organization % has no user',
        binding.platform,
        binding.connection_id,
        binding.channel_id,
        binding.organization_id;
    END IF;

    -- Runtime Behavior creation uses the repository's locked MAX(id)+1
    -- allocator rather than these legacy sequences. Allocate from the live
    -- tables too, otherwise a populated install can have a stale sequence and
    -- collide with an existing primary key during this one-shot migration.
    SELECT COALESCE(MAX(id), 0) + 1 INTO watcher_id FROM watchers;
    SELECT COALESCE(MAX(id), 0) + 1 INTO version_id FROM watcher_versions;
    behavior_trigger := jsonb_build_array(
      jsonb_build_object(
        'kind', 'event',
        'connector_key', binding.platform,
        'connection_id', binding.connection_id,
        'event_types', jsonb_build_array('message.created'),
        'match', jsonb_strip_nulls(jsonb_build_object(
          'channel_id', native_channel_id,
          'team_id', binding.team_id
        )),
        'execution', 'turn',
        'active_run', 'steer',
        'output', 'reply_to_source',
        'skip_if_unchanged', false
      )
    );

    INSERT INTO watchers (
      id,
      name,
      slug,
      description,
      organization_id,
      entity_ids,
      schedule,
      next_run_at,
      triggers,
      agent_id,
      model_config,
      execution_config,
      sources,
      version,
      current_version_id,
      tags,
      status,
      created_by,
      created_at,
      updated_at,
      watcher_group_id
    ) VALUES (
      watcher_id,
      'Messages in ' || binding.channel_id,
      'chat-' || binding.platform || '-' || watcher_id,
      'Migrated chat subscription',
      binding.organization_id,
      '{}'::bigint[],
      NULL,
      NULL,
      behavior_trigger,
      binding.agent_id,
      '{}'::jsonb,
      CASE
        WHEN binding.model IS NULL THEN NULL
        ELSE jsonb_build_object('model', binding.model)
      END,
      '[]'::jsonb,
      1,
      NULL,
      ARRAY['system:chat-link']::text[],
      'active',
      created_by_user,
      binding.created_at,
      binding.created_at,
      watcher_id
    );

    INSERT INTO watcher_versions (
      id,
      watcher_id,
      version,
      name,
      description,
      prompt,
      version_sources,
      change_notes,
      created_by,
      created_at
    ) VALUES (
      version_id,
      watcher_id,
      1,
      'Messages in ' || binding.channel_id,
      'Migrated chat subscription',
      'Respond helpfully to the incoming message.',
      '[]'::jsonb,
      'Migrated from channel binding',
      created_by_user,
      binding.created_at
    );

    UPDATE watchers
    SET current_version_id = version_id
    WHERE id = watcher_id;
  END LOOP;
END
$migration$;

-- Canonical read projection for every chat-routing consumer. This is an
-- ordinary view (no stored state): Behaviors remain the sole source of truth.
CREATE OR REPLACE VIEW behavior_message_subscriptions AS
SELECT
  w.id AS behavior_id,
  w.organization_id,
  w.agent_id,
  trigger->>'connector_key' AS platform,
  COALESCE(
    NULLIF(trigger->'match'->>'channel_key', ''),
    (trigger->>'connector_key') || ':' || (trigger->'match'->>'channel_id')
  ) AS channel_id,
  trigger->'match'->>'channel_id' AS native_channel_id,
  COALESCE(
    NULLIF(trigger->'match'->>'team_id', ''),
    c.external_tenant_id,
    c.config->'chatMetadata'->>'teamId'
  ) AS team_id,
  NULLIF(trigger->'match'->>'team_id', '') AS trigger_team_id,
  c.id AS connection_id,
  c.organization_id AS connection_organization_id,
  c.slug AS connection_slug,
  CASE WHEN c.slug LIKE 'agentconn-%'
    THEN substring(c.slug FROM 11) ELSE c.slug END AS runtime_connection_id,
  c.status AS connection_status,
  c.credential_mode,
  c.config->'settings'->'previewMode' = 'true'::jsonb AS preview_mode,
  COALESCE(c.external_tenant_id, c.config->'chatMetadata'->>'teamId')
    AS connection_team_id,
  NULLIF(w.execution_config->>'model', '') AS model,
  w.created_at,
  w.updated_at
FROM watchers w
CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.triggers, '[]'::jsonb)) trigger
JOIN connections c
  ON c.id = CASE
    WHEN jsonb_typeof(trigger->'connection_id') = 'number'
      THEN (trigger->>'connection_id')::bigint
    ELSE NULL
  END
 AND c.connector_key = trigger->>'connector_key'
 AND c.deleted_at IS NULL
WHERE w.status = 'active'
  AND w.agent_id IS NOT NULL
  AND trigger->>'kind' = 'event'
  AND jsonb_typeof(trigger->'connection_id') = 'number'
  AND trigger->'event_types' ? 'message.created'
  AND jsonb_typeof(trigger->'match') = 'object'
  AND NULLIF(trigger->'match'->>'channel_id', '') IS NOT NULL;

-- Connection removal is a soft delete in every production path. Retire the
-- canonical chat Behaviors when the connection tombstone lands.
CREATE OR REPLACE FUNCTION archive_chat_behaviors_for_deleted_connection()
RETURNS trigger
LANGUAGE plpgsql
AS $archive$
BEGIN
  UPDATE watchers w
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

DROP TRIGGER IF EXISTS archive_chat_behaviors_for_deleted_connection
  ON connections;
CREATE TRIGGER archive_chat_behaviors_for_deleted_connection
AFTER UPDATE OF deleted_at ON connections
FOR EACH ROW
WHEN (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL)
EXECUTE FUNCTION archive_chat_behaviors_for_deleted_connection();

-- Clean cut: drop the legacy table (cascades any leftover dual-write triggers)
-- and any orphaned bridge functions from intermediate PR revisions.
-- squawk-ignore ban-drop-table -- intentional one-shot clean-cut after backfill; no dual-write bridge retained
DROP TABLE IF EXISTS agent_channel_bindings CASCADE;
DROP FUNCTION IF EXISTS sync_legacy_channel_binding_behavior();
DROP FUNCTION IF EXISTS lock_legacy_channel_binding_projection();

-- migrate:down

-- Archive active chat-link Behaviors created by the forward migration. Rows
-- remain as archived history; this rollback never deletes them. The legacy
-- bindings table is not reconstructed — clean cut is not reversible to mixed
-- dual-write runtime.
UPDATE watchers w
SET status = 'archived', updated_at = current_timestamp
WHERE w.status = 'active'
  AND w.tags @> ARRAY['system:chat-link']::text[]
  AND EXISTS (
    SELECT 1
    FROM jsonb_array_elements(COALESCE(w.triggers, '[]'::jsonb)) trigger
    WHERE trigger->>'kind' = 'event'
      AND trigger->'event_types' ? 'message.created'
  );

DROP VIEW IF EXISTS behavior_message_subscriptions;

DROP TRIGGER IF EXISTS archive_chat_behaviors_for_deleted_connection
  ON connections;

DROP FUNCTION IF EXISTS archive_chat_behaviors_for_deleted_connection();
