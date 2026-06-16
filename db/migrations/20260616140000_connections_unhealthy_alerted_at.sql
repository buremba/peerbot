-- migrate:up

-- Transition marker for the connector-health alerter.
--
-- A connector silently dying (every feed failing, zero feeds, or no successful
-- sync in N days) currently surfaces to nobody. The `connector-health-alert`
-- scheduled job (single-claimant, runs-queue-mediated) scans active connections
-- each tick and emits a `logger.error` — which the pino→Sentry bridge forwards
-- to the existing Sentry→Slack alert path — when a connection newly becomes
-- unhealthy.
--
-- This column is the multi-replica-safe dedupe: the alert fires only on the
-- NULL → set transition (the tick that flips it claims the alert via an atomic
-- conditional UPDATE), so N replicas ticking concurrently can never double-fire.
-- It is cleared back to NULL when the connection recovers, which re-arms the
-- alert for the next time it dies. No per-pod in-memory state is involved.
ALTER TABLE public.connections
    ADD COLUMN IF NOT EXISTS unhealthy_alerted_at timestamp with time zone;

COMMENT ON COLUMN public.connections.unhealthy_alerted_at IS
    'Set by the connector-health-alert job when the connection is flagged unhealthy; cleared on recovery. Drives transition-only (not every-tick) alerting, multi-replica-safe.';

-- migrate:down

ALTER TABLE public.connections DROP COLUMN IF EXISTS unhealthy_alerted_at;
