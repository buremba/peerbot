-- migrate:up

-- Cluster-wide fixed-window rate-limit counters.
--
-- The in-memory limiter in packages/server/src/utils/rate-limiter.ts was
-- per-pod, so an N-replica deployment multiplied every IP limit by N (and a
-- pod restart reset all windows). Each check now performs one atomic UPSERT
-- (INSERT ... ON CONFLICT ... DO UPDATE SET count = count + 1 RETURNING count)
-- against this table, so the count is shared by every replica.
--
-- UNLOGGED is deliberate: counters are ephemeral abuse-control state. Losing
-- them on a Postgres crash merely resets the current windows (the same thing
-- a pod restart did under the old in-memory limiter) in exchange for not
-- paying WAL writes on every rate-limited request.
--
-- `window_start` is the truncated start of the fixed window. Rows expire
-- naturally once their window passes; the limiter sweeps stale rows
-- opportunistically (anything older than the largest configured window).

CREATE UNLOGGED TABLE IF NOT EXISTS public.rate_limit_counters (
    key text NOT NULL,
    window_start timestamptz NOT NULL,
    count integer NOT NULL DEFAULT 0,
    PRIMARY KEY (key, window_start)
);

-- The sweep deletes by window_start alone; the composite PK (key, window_start)
-- can't serve that range predicate, so give it its own index.
CREATE INDEX IF NOT EXISTS rate_limit_counters_window_start_idx
    ON public.rate_limit_counters (window_start);

-- migrate:down

DROP TABLE IF EXISTS public.rate_limit_counters;
