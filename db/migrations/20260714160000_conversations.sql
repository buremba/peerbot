-- migrate:up

-- First-class `conversations` entity: the SINGLE source of truth for the
-- conversation sidebar/listing, replacing the derived
-- `DISTINCT ON (conversation_id) FROM agent_transcript_snapshot` reverse-parse
-- path. One row per conversation across all platforms (web, Slack, Telegram, …),
-- materialized on the first turn that dispatches through the gateway.
--
-- Identity = (organization_id, agent_id, platform, conversation_id). The
-- conversation_id already carries the platform-native address
-- (`slack:{channel}:{thread}`, the packed web id, …); platform is stored
-- explicitly so it's never parsed back out. NOTE: connection_id is deliberately
-- NOT part of identity — it's a delivery/routing attribute (which install
-- delivered the message) that can change on reconnect, so keying on it would
-- fragment one conversation's history across connections. The rare
-- same-channel-across-two-workspaces (Grid) case is disambiguated by workspace
-- (team_id) and is handled by the channel-visibility ACL failing closed, not by
-- the conversation key.
--
-- Scope is deliberately minimal: identity + listing only. The runtime pin
-- (sandbox_*) and branch lineage (parent_*) columns are introduced by the
-- follow-ups that actually read/write them, not speculatively here.
CREATE TABLE IF NOT EXISTS public.conversations (
  organization_id  text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
  agent_id         text NOT NULL,
  -- Platform explicit-stored (never parsed from the id string). Web/API
  -- conversations use 'web'; platform conversations use 'slack'/'telegram'/….
  platform         text NOT NULL,
  -- Platform-native conversation id (e.g. 'C0123:1700000000.0001', or the
  -- packed web id '{agentId}_{userId}_{org}_{threadId}').
  conversation_id  text NOT NULL,

  -- 'owned'    = web/API conversation owned by a user
  -- 'platform' = a platform channel/thread (Slack, Telegram, …)
  kind             text NOT NULL,
  user_id          text,
  title            text,
  last_activity_at timestamptz,

  archived_at      timestamptz,        -- soft-delete only; NEVER hard-delete identity
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT conversations_pkey
    PRIMARY KEY (organization_id, agent_id, platform, conversation_id),

  CONSTRAINT conversations_kind_check
    CHECK (kind IN ('owned', 'platform'))
);

-- Sidebar/listing: newest-first per (org, agent), non-archived.
-- squawk-ignore require-concurrent-index-creation -- table created immediately above; no existing rows/traffic
CREATE INDEX IF NOT EXISTS conversations_listing
  ON public.conversations (organization_id, agent_id, last_activity_at DESC)
  WHERE archived_at IS NULL;

-- migrate:down
-- squawk-ignore ban-drop-table -- rollback path for the table introduced by this migration
DROP TABLE IF EXISTS public.conversations;
