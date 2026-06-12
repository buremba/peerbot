-- migrate:up

-- Single-claimant leases for exclusive-transport chat connections.
--
-- Webhook-based connections are stateless request handlers: any replica can
-- hydrate one from its `agent_connections` row on demand, so they need no
-- ownership. Exclusive transports (today: Telegram long-polling) hold a
-- persistent outbound loop where two replicas running the same connection is
-- *incorrect* (Telegram returns 409 on concurrent getUpdates and updates are
-- dropped nondeterministically). Each gateway replica ticks a claim loop:
-- one atomic UPSERT per exclusive connection wins or renews the lease; the
-- winner runs the polling instance and its ticks act as heartbeats. A pod
-- that dies stops heartbeating and another replica reclaims after the TTL
-- (enforced in the UPSERT's WHERE, not here).
--
-- UNLOGGED is deliberate: a lease is ephemeral coordination state. Losing the
-- table on a Postgres crash just means the next tick re-elects owners — the
-- same convergence path as a pod restart.

CREATE UNLOGGED TABLE IF NOT EXISTS public.connection_claims (
    connection_id text PRIMARY KEY,
    claimed_by text NOT NULL,
    heartbeat_at timestamptz NOT NULL DEFAULT now()
);

-- Close the duplicate-Slack-install race: two concurrent OAuth installs for
-- the same workspace both pass the find-by-teamId check and insert two rows.
-- Enforce one non-stopped Slack connection per (org, workspace) at the DB
-- layer; the coordinator catches the violation and converges on the winner.
-- Pre-existing duplicates (created by the race this index closes) are
-- demoted to 'stopped' — newest updated_at wins — so the index can build.
-- Rows are kept (not deleted) so history/secrets stay anchored for operator
-- review.
UPDATE public.agent_connections ac
SET status = 'stopped',
    error_message = COALESCE(ac.error_message,
      'Demoted duplicate Slack workspace connection (kept newest)'),
    updated_at = now()
WHERE ac.platform = 'slack'
  AND ac.metadata->>'teamId' IS NOT NULL
  AND ac.status <> 'stopped'
  AND EXISTS (
    SELECT 1 FROM public.agent_connections newer
    WHERE newer.platform = 'slack'
      AND newer.status <> 'stopped'
      AND COALESCE(newer.organization_id, '') = COALESCE(ac.organization_id, '')
      AND newer.metadata->>'teamId' = ac.metadata->>'teamId'
      AND (newer.updated_at > ac.updated_at
           OR (newer.updated_at = ac.updated_at AND newer.id > ac.id))
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_connections_slack_workspace
    ON public.agent_connections ((COALESCE(organization_id, '')), ((metadata->>'teamId')))
    WHERE platform = 'slack'
      AND metadata->>'teamId' IS NOT NULL
      AND status <> 'stopped';

-- migrate:down

DROP INDEX IF EXISTS public.idx_agent_connections_slack_workspace;
DROP TABLE IF EXISTS public.connection_claims;
-- The duplicate-demotion UPDATE is not reversed: demoted rows keep
-- status='stopped' with the explanatory error_message (data, not schema).
