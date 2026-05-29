-- migrate:up

-- Schema drift repair: `connections.entity_ids` exists in the squashed baseline
-- (00000000000000_baseline.sql) with a GIN index, but installs provisioned from
-- an *older* pre-squash baseline applied the column to events/watchers/feeds and
-- never to connections. Those databases (e.g. the prod `owletto` DB) are missing
-- both the column and its index, so any query that projects connections.entity_ids
-- — including the admin `query_sql` tool whose SAFE_COLUMN_DEFS allowlist lists it
-- — fails with `column "entity_ids" does not exist`.
--
-- This delta is idempotent: a no-op on fresh installs (baseline already created
-- the column + index) and a repair on drifted databases. Matches the baseline
-- definition exactly so the allowlist stays consistent with the real schema.
ALTER TABLE public.connections ADD COLUMN IF NOT EXISTS entity_ids bigint[];

CREATE INDEX IF NOT EXISTS idx_connections_entity_ids ON public.connections USING gin (entity_ids);

-- migrate:down

DROP INDEX IF EXISTS public.idx_connections_entity_ids;

ALTER TABLE public.connections DROP COLUMN IF EXISTS entity_ids;
