-- migrate:up

-- Channel subscriptions are Behaviors. Backfill the legacy routing rows into
-- ordinary watcher/version records. Keep the legacy table for one rolling
-- deployment so old replicas can finish safely while a compatibility projection
-- synchronizes their writes with the new runtime. A later contract migration
-- must replay this backfill after old replicas are gone, then remove the table
-- and bridge.

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
  -- Migrations are transactional. Hold old writers until the backfill and the
  -- compatibility trigger commit together, so no binding can land between the
  -- snapshot and trigger installation.
  LOCK TABLE agent_channel_bindings IN SHARE ROW EXCLUSIVE MODE;

  -- Share the canonical runtime allocator locks while deriving MAX(id)+1.
  -- This keeps a rolling-deploy writer from choosing the same IDs while the
  -- legacy rows are being folded into Behaviors.
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
        AND trigger->>'kind' = 'event'
        AND trigger->>'connector_key' = binding.platform
        AND trigger->>'connection_id' = binding.connection_id::text
        AND trigger->'event_types' ? 'message.created'
        AND trigger->'match'->>'channel_id' = native_channel_id
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

-- Old replicas still write the retained table during the rolling deployment.
-- Fold those writes into the tagged canonical Behavior under the same advisory
-- lock used by the new runtime. New replicas mirror their writes in the other
-- direction, making the table a temporary compatibility projection rather than
-- an independent source of truth.
CREATE OR REPLACE FUNCTION sync_legacy_channel_binding_behavior()
RETURNS trigger
LANGUAGE plpgsql
AS $bridge$
DECLARE
  native_channel_id text;
  behavior_trigger jsonb;
  behavior_id integer;
  version_id integer;
  created_by_user text;
BEGIN
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND NEW.connection_id IS NULL) THEN
    native_channel_id := CASE
      WHEN OLD.channel_id LIKE OLD.platform || ':%'
        THEN substring(OLD.channel_id FROM length(OLD.platform) + 2)
      ELSE OLD.channel_id
    END;
    UPDATE watchers w
    SET status = 'archived', updated_at = current_timestamp
    WHERE w.status = 'active'
      AND w.organization_id = OLD.organization_id
      AND w.agent_id = OLD.agent_id
      AND w.tags @> ARRAY['system:chat-link']::text[]
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(w.triggers, '[]'::jsonb)) trigger
        WHERE trigger->>'kind' = 'event'
          AND trigger->>'connector_key' = OLD.platform
          AND jsonb_typeof(trigger->'connection_id') = 'number'
          AND (trigger->>'connection_id')::bigint = OLD.connection_id
          AND trigger->'event_types' ? 'message.created'
          AND trigger->'match'->>'channel_id' = native_channel_id
      );
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM connections c
    WHERE c.id = NEW.connection_id
      AND c.connector_key = NEW.platform
      AND c.deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION
      'Cannot sync channel subscription: connection % is not an active % connection',
      NEW.connection_id,
      NEW.platform;
  END IF;

  native_channel_id := CASE
    WHEN NEW.channel_id LIKE NEW.platform || ':%'
      THEN substring(NEW.channel_id FROM length(NEW.platform) + 2)
    ELSE NEW.channel_id
  END;
  behavior_trigger := jsonb_build_array(
    jsonb_build_object(
      'kind', 'event',
      'connector_key', NEW.platform,
      'connection_id', NEW.connection_id,
      'event_types', jsonb_build_array('message.created'),
      'match', jsonb_strip_nulls(jsonb_build_object(
        'channel_id', native_channel_id,
        'team_id', NEW.team_id
      )),
      'execution', 'turn',
      'active_run', 'steer',
      'output', 'reply_to_source',
      'skip_if_unchanged', false
    )
  );

  SELECT w.id INTO behavior_id
  FROM watchers w
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(w.triggers, '[]'::jsonb)) trigger
  WHERE w.status = 'active'
    AND w.organization_id = NEW.organization_id
    AND w.tags @> ARRAY['system:chat-link']::text[]
    AND trigger->>'kind' = 'event'
    AND trigger->>'connector_key' = NEW.platform
    AND jsonb_typeof(trigger->'connection_id') = 'number'
    AND (trigger->>'connection_id')::bigint = NEW.connection_id
    AND trigger->'event_types' ? 'message.created'
    AND trigger->'match'->>'channel_id' = native_channel_id
  ORDER BY w.updated_at DESC, w.id DESC
  LIMIT 1
  FOR UPDATE OF w;

  IF behavior_id IS NOT NULL THEN
    UPDATE watchers
    SET agent_id = NEW.agent_id,
        triggers = (
          SELECT jsonb_agg(
            CASE
              WHEN trigger->>'kind' = 'event'
                AND trigger->>'connector_key' = NEW.platform
                AND jsonb_typeof(trigger->'connection_id') = 'number'
                AND (trigger->>'connection_id')::bigint = NEW.connection_id
                AND trigger->'event_types' ? 'message.created'
                AND trigger->'match'->>'channel_id' = native_channel_id
                THEN behavior_trigger->0
              ELSE trigger
            END
            ORDER BY ordinal
          )
          FROM jsonb_array_elements(COALESCE(watchers.triggers, '[]'::jsonb))
            WITH ORDINALITY AS item(trigger, ordinal)
        ),
        execution_config = CASE
          WHEN NULLIF(trim(NEW.model), '') IS NULL
            THEN NULLIF(COALESCE(execution_config, '{}'::jsonb) - 'model', '{}'::jsonb)
          ELSE COALESCE(execution_config, '{}'::jsonb)
            || jsonb_build_object('model', trim(NEW.model))
        END,
        updated_at = current_timestamp
    WHERE id = behavior_id;
    RETURN NEW;
  END IF;

  SELECT COALESCE(
    (
      SELECT a.owner_user_id
      FROM agents a
      JOIN "user" u ON u.id = a.owner_user_id
      WHERE a.organization_id = NEW.organization_id
        AND a.id = NEW.agent_id
        AND a.owner_user_id IS NOT NULL
      LIMIT 1
    ),
    (
      SELECT m."userId"
      FROM member m
      JOIN "user" u ON u.id = m."userId"
      WHERE m."organizationId" = NEW.organization_id
      ORDER BY m."createdAt", m.id
      LIMIT 1
    )
  ) INTO created_by_user;
  IF created_by_user IS NULL THEN
    RAISE EXCEPTION
      'Cannot sync channel subscription: organization % has no user',
      NEW.organization_id;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('watchers_id_alloc'));
  PERFORM pg_advisory_xact_lock(hashtext('watcher_versions_id_alloc'));
  SELECT COALESCE(MAX(id), 0) + 1 INTO behavior_id FROM watchers;
  SELECT COALESCE(MAX(id), 0) + 1 INTO version_id FROM watcher_versions;

  INSERT INTO watchers (
    id, name, slug, description, organization_id, entity_ids,
    schedule, next_run_at, triggers, agent_id, model_config,
    execution_config, sources, version, current_version_id, tags,
    status, created_by, created_at, updated_at, watcher_group_id
  ) VALUES (
    behavior_id, 'Messages in ' || NEW.channel_id,
    'chat-' || NEW.platform || '-' || behavior_id, 'Chat subscription',
    NEW.organization_id, '{}'::bigint[], NULL, NULL, behavior_trigger,
    NEW.agent_id, '{}'::jsonb,
    CASE
      WHEN NULLIF(trim(NEW.model), '') IS NULL THEN NULL
      ELSE jsonb_build_object('model', trim(NEW.model))
    END,
    '[]'::jsonb, 1, NULL, ARRAY['system:chat-link']::text[], 'active',
    created_by_user, current_timestamp, current_timestamp, behavior_id
  );
  INSERT INTO watcher_versions (
    id, watcher_id, version, name, description, prompt,
    version_sources, change_notes, created_by, created_at
  ) VALUES (
    version_id, behavior_id, 1, 'Messages in ' || NEW.channel_id,
    'Chat subscription', 'Respond helpfully to the incoming message.',
    '[]'::jsonb, 'Created from rolling channel binding',
    created_by_user, current_timestamp
  );
  UPDATE watchers SET current_version_id = version_id WHERE id = behavior_id;
  RETURN NEW;
END
$bridge$;

-- Acquire this before the old statement locks a binding row. New replicas take
-- the same lock before touching Behaviors, preventing cross-table lock-order
-- inversions while both runtime versions are live. Chat-link writes are rare,
-- so rollout-wide serialization is preferable to a deadlock-prone keyed lock.
CREATE OR REPLACE FUNCTION lock_legacy_channel_binding_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $lock$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('behavior_chat_link_rollout'));
  RETURN NULL;
END
$lock$;

DROP TRIGGER IF EXISTS lock_legacy_channel_binding_projection
  ON agent_channel_bindings;
CREATE TRIGGER lock_legacy_channel_binding_projection
BEFORE INSERT OR UPDATE OR DELETE ON agent_channel_bindings
FOR EACH STATEMENT EXECUTE FUNCTION lock_legacy_channel_binding_projection();
DROP TRIGGER IF EXISTS sync_legacy_channel_binding_behavior
  ON agent_channel_bindings;
CREATE TRIGGER sync_legacy_channel_binding_behavior
AFTER INSERT OR UPDATE OR DELETE ON agent_channel_bindings
FOR EACH ROW EXECUTE FUNCTION sync_legacy_channel_binding_behavior();

-- Connection removal is a soft delete in every production path, so the legacy
-- binding FK never fires. Retire the canonical chat Behaviors directly when the
-- connection tombstone lands. Keeping this at the database seam covers managed
-- and BYO deletion from every replica and every service path.
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

-- migrate:down

DROP TRIGGER IF EXISTS sync_legacy_channel_binding_behavior
  ON agent_channel_bindings;
DROP TRIGGER IF EXISTS lock_legacy_channel_binding_projection
  ON agent_channel_bindings;
DROP TRIGGER IF EXISTS archive_chat_behaviors_for_deleted_connection
  ON connections;

DROP FUNCTION IF EXISTS sync_legacy_channel_binding_behavior();
DROP FUNCTION IF EXISTS lock_legacy_channel_binding_projection();
DROP FUNCTION IF EXISTS archive_chat_behaviors_for_deleted_connection();
