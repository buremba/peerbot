-- migrate:up

-- Idempotency ledger + audit trail for the native conversation `send_message`
-- tool. Watcher/scheduled runs retry (whole-job replay), so without a dedup key
-- an agent double-posts. Every send computes a key from
-- (org, agent, run-conversation, target, content[, client key]) and inserts
-- here with ON CONFLICT DO NOTHING; a conflict means "already sent" → return the
-- prior message handle instead of reposting. The row is also the audit record:
-- who posted what, where, when.
CREATE TABLE public.conversation_sends (
    idempotency_key text PRIMARY KEY,
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    -- The worker token's conversationId — i.e. which run/turn issued the send.
    -- Used both for run-scoped idempotency and a per-run send-count rate guard.
    run_conversation_id text,
    connection_id text NOT NULL,
    platform text NOT NULL,
    target_handle text NOT NULL,
    channel_id text NOT NULL,
    thread_id text,
    -- Platform message id of the sent message (null if the adapter returned none).
    message_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

-- Audit / rate-limit lookups: "sends by this agent in org recently" and
-- "sends in this run" (the per-run cap).
CREATE INDEX idx_conversation_sends_org_agent_created
    ON public.conversation_sends (organization_id, agent_id, created_at DESC);
CREATE INDEX idx_conversation_sends_run
    ON public.conversation_sends (run_conversation_id);

-- migrate:down

DROP TABLE IF EXISTS public.conversation_sends;
