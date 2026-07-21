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
-- A real pending approval: the "Daily spend digest" behavior proposed
-- posting to Slack. This creates (a) a pending action run, (b) an approval
-- event carrying interaction data so EventCard renders the editable proposed
-- message + Confirm/Reject buttons, and (c) a notification pointing at it.
-- Clicking the notification opens the Memory events peek pane (not navigate).
-- ---------------------------------------------------------------------------

-- (a) Pending action run awaiting human approval.
INSERT INTO runs (
  organization_id, run_type, status, connector_key, connection_id,
  created_at, run_at, approval_status, items_collected,
  created_by_user_id, run_metadata
) VALUES (
  :'ORG', 'action', 'pending', 'slack', 1,
  now() - interval '20 minutes', now() - interval '20 minutes',
  'pending', 0, :'USER',
  '{"seed":"peek","proposer":"behavior:daily-spend-digest"}'::jsonb
)
RETURNING id AS approval_run_id \gset

-- (b) Approval event with interaction data → ActionApprovalCard renders the
--     editable proposed message + Confirm/Reject buttons in the peek pane.
INSERT INTO events (
  organization_id, title, semantic_type, interaction_type, interaction_status,
  interaction_input_schema, interaction_input, run_id, occurred_at, created_at,
  created_by, metadata
) VALUES (
  :'ORG',
  'Proposed: post spend digest to #finance',
  'operation', 'approval', 'pending',
  '{"type":"object","properties":{"channel":{"type":"string","title":"Slack channel"},"message":{"type":"string","title":"Message","format":"textarea"}},"required":["channel","message"]}'::jsonb,
  jsonb_build_object('channel','#finance','message',E'## Daily Spend Digest — Jul 18\nTotal: €1,847.30 across 12 transactions\nFlagged: AWS Production €640, Booking.com €589'),
  :approval_run_id,
  now() - interval '20 minutes', now() - interval '20 minutes',
  :'USER',
  jsonb_build_object('seed','peek','run_id',:approval_run_id,'action_name','Post message','connection_name','#finance (Slack)')
);

-- (c) Notification pointing at the approval run (peek target).
WITH ev AS (
  INSERT INTO events (
    organization_id, title, payload_text, payload_type, semantic_type,
    interaction_type, interaction_status, metadata, occurred_at, created_at,
    created_by
  ) VALUES (
    :'ORG',
    'Approval needed: send digest to #finance',
    'Behavior "Daily spend digest" wants to post a summary to the #finance channel. Review the proposed message before it sends.',
    'markdown', 'content', 'none', null,
    jsonb_build_object('seed','peek','notification_type','action_approval_needed','resource_type','run','resource_url','/local-install/memory?view=events&run_ids=' || :approval_run_id),
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

-- ---------------------------------------------------------------------------
-- Transcripts (agent_transcript_snapshot) so behavior runs show real content.
-- Each is a session.jsonl conversation: prompt → analysis → tool calls → summary.
-- ---------------------------------------------------------------------------
\set ORG 'org_47ya40wa5k8'

DELETE FROM agent_transcript_snapshot WHERE conversation_id LIKE 'seed-watch-%';

INSERT INTO agent_transcript_snapshot
  (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status, created_at)
SELECT :'ORG', 'owletto-default', 'seed-watch-9001-run-976', 976,
$jsonl${"type":"message","id":"m1","parentId":null,"timestamp":"2026-07-19T09:00:01Z","message":{"role":"user","content":"Run this Behavior now: Daily spend digest. Summarize yesterday's card transactions and flag anomalies over $500."}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-07-19T09:00:03Z","message":{"role":"assistant","content":[{"type":"text","text":"I'll pull yesterday's transactions from the connected Revolut account and analyze them for anomalies."}]}}
{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-07-19T09:00:05Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"list_transactions","input":{"since":"2026-07-18","until":"2026-07-19"}}]}}
{"type":"message","id":"m4","parentId":"m3","timestamp":"2026-07-19T09:00:09Z","message":{"role":"toolResult","content":[{"type":"tool_result","tool_use_id":"tu1","content":"12 transactions returned, total: €1,847.30"}]}}
{"type":"message","id":"m5","parentId":"m4","timestamp":"2026-07-19T09:00:12Z","message":{"role":"assistant","content":[{"type":"text","text":"## Daily Spend Digest — Jul 18\n\n**Total: €1,847.30 across 12 transactions**\n\n### Flagged (over €500)\n- **AWS Production** — €640.00 (monthly infra)\n- **Booking.com** — €589.00 (hotel, Lisbon)\n\n### Recurring\n- Netflix €15.99, Spotify €10.99, Notion €9.00\n\n### Notes\nSpend is 23% above your 30-day average (€1,503). The Lisbon hotel is the main driver. No unusual or suspicious transactions detected."}]}}$jsonl$,
128, 'completed', now() - interval '25 hours'
ON CONFLICT (organization_id, agent_id, conversation_id, run_id) DO UPDATE SET snapshot_jsonl = EXCLUDED.snapshot_jsonl;

INSERT INTO agent_transcript_snapshot
  (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status, created_at)
SELECT :'ORG', 'owletto-default', 'seed-watch-9001-run-977', 977,
$jsonl${"type":"message","id":"m1","parentId":null,"timestamp":"2026-07-18T09:00:01Z","message":{"role":"user","content":"Run this Behavior now: Daily spend digest."}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-07-18T09:00:03Z","message":{"role":"assistant","content":[{"type":"text","text":"Fetching yesterday's transactions from Revolut..."}]}}
{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-07-18T09:00:40Z","message":{"role":"assistant","content":[{"type":"text","text":"⚠️ The Revolut connector returned 502 Bad Gateway after 3 retries. I cannot complete the digest without transaction data. The run will be marked as failed — it will retry on the next scheduled run."}]}}$jsonl$,
64, 'failed', now() - interval '49 hours'
ON CONFLICT (organization_id, agent_id, conversation_id, run_id) DO UPDATE SET snapshot_jsonl = EXCLUDED.snapshot_jsonl;

INSERT INTO agent_transcript_snapshot
  (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status, created_at)
SELECT :'ORG', 'owletto-default', 'seed-watch-9002-run-978', 978,
$jsonl${"type":"message","id":"m1","parentId":null,"timestamp":"2026-07-20T22:00:01Z","message":{"role":"user","content":"Run this Behavior now: Inbox triage. Flag emails needing a reply and draft suggested responses."}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-07-20T22:00:03Z","message":{"role":"assistant","content":[{"type":"text","text":"Scanning the inbox for emails received in the last 30 minutes..."}]}}
{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-07-20T22:00:06Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"list_emails","input":{"folder":"inbox","since_minutes":30}}]}}
{"type":"message","id":"m4","parentId":"m3","timestamp":"2026-07-20T22:00:10Z","message":{"role":"toolResult","content":[{"type":"tool_result","tool_use_id":"tu1","content":"8 emails returned, 3 unread"}]}}
{"type":"message","id":"m5","parentId":"m4","timestamp":"2026-07-20T22:00:14Z","message":{"role":"assistant","content":[{"type":"text","text":"## Inbox Triage — 5 emails needing attention\n\n### 🔴 Needs reply\n1. **Sara Chen** (re: Q3 roadmap feedback) — waiting on your sign-off\n2. **Stripe** (re: payout failed) — action required\n\n### 🟡 FYI\n3. **GitHub** — security alert resolved\n4. **Linear** — weekly digest\n\n### ✅ No action\n5. **Notion** — product update\n\nI've drafted suggested replies for items 1-2 and saved them as drafts."}]}}$jsonl$,
128, 'completed', now() - interval '2 hours'
ON CONFLICT (organization_id, agent_id, conversation_id, run_id) DO UPDATE SET snapshot_jsonl = EXCLUDED.snapshot_jsonl;

INSERT INTO agent_transcript_snapshot
  (organization_id, agent_id, conversation_id, run_id, snapshot_jsonl, byte_size, terminal_status, created_at)
SELECT :'ORG', 'lobu-builder', 'seed-watch-9003-run-980', 980,
$jsonl${"type":"message","id":"m1","parentId":null,"timestamp":"2026-07-20T19:00:01Z","message":{"role":"user","content":"Run this Behavior now: Stale workspace watcher. Alert when a workspace has no activity for 7 days."}}
{"type":"message","id":"m2","parentId":"m1","timestamp":"2026-07-20T19:00:03Z","message":{"role":"assistant","content":[{"type":"text","text":"Checking all workspaces for activity in the last 7 days..."}]}}
{"type":"message","id":"m3","parentId":"m2","timestamp":"2026-07-20T19:00:07Z","message":{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"list_workspaces","input":{"inactive_days":7}}]}}
{"type":"message","id":"m4","parentId":"m3","timestamp":"2026-07-20T19:00:11Z","message":{"role":"toolResult","content":[{"type":"tool_result","tool_use_id":"tu1","content":"1 stale workspace found: 'acme-demo' (last activity 11 days ago)"}]}}
{"type":"message","id":"m5","parentId":"m4","timestamp":"2026-07-20T19:00:14Z","message":{"role":"assistant","content":[{"type":"text","text":"## Stale Workspace Report\n\nFound **1 workspace** with no activity in 7+ days:\n\n- **acme-demo** — last active 11 days ago\n\nThis workspace has 3 idle behaviors and 2 disconnected connectors. Consider archiving it or pinging the owner."}]}}$jsonl$,
128, 'completed', now() - interval '5 hours'
ON CONFLICT (organization_id, agent_id, conversation_id, run_id) DO UPDATE SET snapshot_jsonl = EXCLUDED.snapshot_jsonl;
