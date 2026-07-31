-- `conversations.is_direct` — is this platform conversation a 1:1 DM with the
-- bot, rather than a group channel?
--
-- Why it must be stored rather than derived: platform conversation ids carry no
-- portable DM marker. Telegram and Slack use different native id conventions,
-- and future platforms need not encode the distinction in the id at all. The
-- inbound delivery is the common authoritative source, so the message bridge
-- records its surface classification on `platformMetadata`.
--
-- Why the read path needs it: `listAgentThreads(scope:"all")` gates platform
-- rows on the agent's BOUND channels. Explicitly linked DMs can use that path,
-- but an ordinary inbound DM has no binding and was therefore invisible to
-- every requester. Group channels and bound DMs keep the membership fence;
-- owner/admin access may bypass it only for a known DM (matching
-- `manage_conversations.get`).
--
-- NULL = unknown (rows written before this column existed, and any platform
-- that omits the hint). Unknown keeps today's fail-closed behaviour; the value
-- fills in on the conversation's next inbound message via the upsert's COALESCE.

-- migrate:up
ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS is_direct boolean;

-- migrate:down
ALTER TABLE public.conversations
  DROP COLUMN IF EXISTS is_direct;
