-- Seed realistic activity for the notification-peek E2E test.
-- Idempotent + safe to re-run. Seed rows are tagged with
-- run_metadata->>'seed' = 'peek' and events.metadata->>'seed' = 'peek'
-- so this script can clean them up without touching real data.
--
-- Org:    local-install (org_47ya40wa5k8)
-- User:   user_install_Eu_pgz479nU   (also used for FK created_by columns)
-- Agents: lobu-builder, owletto-default

\set ORG 'org_47ya40wa5k8'
\set USER 'user_install_Eu_pgz479nU'

BEGIN;

-- Clean previous seed (tagged rows only).
DELETE FROM notification_targets
  USING events
  WHERE notification_targets.event_id = events.id
    AND events.metadata->>'seed' = 'peek';
DELETE FROM events WHERE metadata->>'seed' = 'peek';
DELETE FROM runs WHERE run_metadata->>'seed' = 'peek';
DELETE FROM watchers WHERE tags @> ARRAY['seed-peek']::text[];
DELETE FROM connections WHERE slug = 'seed-gmail';

-- ---------------------------------------------------------------------------
-- Behaviors (watchers). watcher_group_id is NOT NULL but unconstrained.
-- ---------------------------------------------------------------------------
INSERT INTO watchers (
  id, organization_id, agent_id, name, slug, description, status,
  schedule, triggers, model_config, sources, created_by, watcher_group_id,
  created_at, updated_at, notification_channel, notification_priority, tags
) VALUES
  (9001, :'ORG', 'owletto-default', 'Daily spend digest',
   'daily-spend-digest',
   'Summarize yesterday''s card transactions and flag anomalies over $500.',
   'active', '0 9 * * *', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb,
   :'USER', 9001, now() - interval '6 days', now(), 'canvas', 'normal',
   ARRAY['seed-peek']::text[]),
  (9002, :'ORG', 'owletto-default', 'Inbox triage',
   'inbox-triage',
   'Flag emails needing a reply and draft suggested responses.',
   'active', '*/30 * * * *', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb,
   :'USER', 9002, now() - interval '4 days', now(), 'canvas', 'normal',
   ARRAY['seed-peek']::text[]),
  (9003, :'ORG', 'lobu-builder', 'Stale workspace watcher',
   'stale-workspace-watcher',
   'Alert when a workspace has no activity for 7 days.',
   'active', '0 10 * * 1', '[]'::jsonb, '{}'::jsonb, '[]'::jsonb,
   :'USER', 9003, now() - interval '3 days', now(), 'canvas', 'normal',
   ARRAY['seed-peek']::text[])
ON CONFLICT (id) DO UPDATE SET
  name = EXCLUDED.name,
  slug = EXCLUDED.slug,
  description = EXCLUDED.description,
  tags = EXCLUDED.tags;

-- ---------------------------------------------------------------------------
-- Behavior runs (run_type = 'watcher') — the agent-scoped activity feed.
-- ---------------------------------------------------------------------------
INSERT INTO runs (
  organization_id, run_type, status, watcher_id,
  created_at, run_at, completed_at, error_message,
  items_collected, created_by_user_id, run_metadata
) VALUES
  (:'ORG', 'watcher', 'completed', 9001,
   now() - interval '25 hours', now() - interval '25 hours',
   now() - interval '25 hours' + interval '3 minutes', NULL, 12, :'USER',
   '{"seed":"peek"}'::jsonb),
  (:'ORG', 'watcher', 'failed', 9001,
   now() - interval '49 hours', now() - interval '49 hours',
   now() - interval '49 hours' + interval '40 seconds',
   'Upstream feed returned 502 Bad Gateway after 3 retries', 0, :'USER',
   '{"seed":"peek"}'::jsonb),
  (:'ORG', 'watcher', 'completed', 9002,
   now() - interval '2 hours', now() - interval '2 hours',
   now() - interval '2 hours' + interval '90 seconds', NULL, 5, :'USER',
   '{"seed":"peek"}'::jsonb),
  (:'ORG', 'watcher', 'completed', 9002,
   now() - interval '90 minutes', now() - interval '90 minutes',
   now() - interval '90 minutes' + interval '75 seconds', NULL, 8, :'USER',
   '{"seed":"peek"}'::jsonb),
  (:'ORG', 'watcher', 'completed', 9003,
   now() - interval '5 hours', now() - interval '5 hours',
   now() - interval '5 hours' + interval '12 seconds', NULL, 1, :'USER',
   '{"seed":"peek"}'::jsonb);

-- ---------------------------------------------------------------------------
-- One Gmail connection so sync runs link to a real connector detail page.
-- ---------------------------------------------------------------------------
INSERT INTO connections (
  id, organization_id, connector_key, display_name, status, slug,
  credential_mode, created_by, created_at, updated_at
) VALUES
  (1, :'ORG', 'gmail', 'Gmail · work account', 'active', 'seed-gmail',
   'byo', :'USER', now() - interval '10 days', now())
ON CONFLICT (id) DO UPDATE SET
  display_name = EXCLUDED.display_name,
  status = EXCLUDED.status;

-- ---------------------------------------------------------------------------
-- Sync runs (link to the connectors page).
-- ---------------------------------------------------------------------------
INSERT INTO runs (
  organization_id, run_type, status, connector_key, connection_id,
  created_at, run_at, completed_at, error_message, items_collected,
  created_by_user_id, run_metadata
) VALUES
  (:'ORG', 'sync', 'completed', 'gmail', 1,
   now() - interval '3 hours', now() - interval '3 hours',
   now() - interval '3 hours' + interval '20 seconds', NULL, 47, :'USER',
   '{"seed":"peek"}'::jsonb),
  (:'ORG', 'sync', 'failed', 'gmail', 1,
   now() - interval '9 hours', now() - interval '9 hours',
   now() - interval '9 hours' + interval '15 seconds',
   'OAuth token expired — reconnect Gmail', 0, :'USER',
   '{"seed":"peek"}'::jsonb);

-- ---------------------------------------------------------------------------
-- One approval-needed notification (deep-links to Memory for the peek pane).
-- ---------------------------------------------------------------------------
WITH ev AS (
  INSERT INTO events (
    organization_id, title, payload_text, payload_type, semantic_type,
    interaction_type, interaction_status, metadata, occurred_at, created_at,
    created_by
  ) VALUES (
    :'ORG',
    'Approval needed: send digest to #finance',
    'Behavior "Daily spend digest" wants to post a summary to the #finance channel. Review the proposed message before it sends.',
    'text', 'content', 'approval', 'pending',
    '{"seed":"peek","notification_type":"action_approval_needed","resource_type":"run","resource_url":"/local-install/memory?view=events&run_ids=9001"}'::jsonb,
    now(), now(), :'USER'
  ) RETURNING id
)
INSERT INTO notification_targets (event_id, user_id, delivered_at, read_at)
  SELECT id, :'USER', now(), NULL FROM ev;

COMMIT;

\echo '--- seed summary ---'
SELECT 'watchers (seeded)' AS what, count(*) FROM watchers WHERE tags @> ARRAY['seed-peek']::text[]
UNION ALL SELECT 'runs (seeded)', count(*) FROM runs WHERE run_metadata->>'seed' = 'peek'
UNION ALL SELECT 'events (seeded)', count(*) FROM events WHERE metadata->>'seed' = 'peek'
UNION ALL SELECT 'notif targets (seeded)', count(*) FROM notification_targets JOIN events ON events.id = notification_targets.event_id WHERE events.metadata->>'seed' = 'peek';
