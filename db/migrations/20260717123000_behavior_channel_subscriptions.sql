-- Channel subscriptions are Behaviors. Backfill the legacy routing rows into
-- ordinary watcher/version records, then remove the duplicate state table.
-- Runtime readers project active message triggers directly from watchers.

-- Historical Slack Grid rows could contain an enterprise id (E...) where a
-- concrete workspace id (T...) belongs. Heal from the durable channel transcript
-- when possible and otherwise leave it unknown so the first inbound message can
-- fill it. This absorbs the old supervised PR1-data-reconcile.sql into the
-- automatic migration before the source table disappears.
DO $migration$
DECLARE
  binding record;
  watcher_id integer;
  version_id integer;
  created_by_user text;
  native_channel_id text;
  behavior_trigger jsonb;
BEGIN
  -- The table is deliberately removed at the end of the migration. A replay
  -- after a successful application therefore has no work left to perform.
  IF to_regclass('public.agent_channel_bindings') IS NULL THEN
    RETURN;
  END IF;

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

    watcher_id := nextval('watchers_id_seq')::integer;
    version_id := nextval('watcher_template_versions_id_seq')::integer;
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

  DROP TABLE agent_channel_bindings;
END
$migration$;

-- migrate:down
