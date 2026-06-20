-- migrate:up

-- Per-run cost/usage ledger: one row per completed run, parsed out of the
-- transcript snapshot at write time into queryable, denormalized columns. This
-- is the authoritative source for per-org/agent/watcher/user showback and the
-- sliding-window spend caps.
--
-- Why a dedicated table (not events, not runs): the append-only events store
-- reads through current_event_records (an embedding join we don't want on a
-- cost hot path), and the runs queue is pruned on retention so it can't be
-- history. Dimensions are denormalized so every rollup is a plain GROUP BY. (A
-- sibling append-only events row for the metric_series sparklines is a planned
-- follow-up with the showback UI; it is NOT wired in this PR.)
--
-- usd is NULL + unpriced=true when no model in the price catalog (and no org
-- override) can price the run — never a fake $0. The token buckets are always
-- stored. UNIQUE(run_id) makes the write idempotent under snapshot retries and
-- the multi-replica race (first writer wins, mirroring the snapshot row).
CREATE TABLE IF NOT EXISTS public.run_usage (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    organization_id text NOT NULL,
    agent_id text NOT NULL,
    conversation_id text NOT NULL,
    run_id bigint NOT NULL,
    user_id text,
    watcher_id bigint,
    source text,
    provider text,
    model text,
    input_tokens bigint NOT NULL DEFAULT 0,
    output_tokens bigint NOT NULL DEFAULT 0,
    cache_read_tokens bigint NOT NULL DEFAULT 0,
    cache_write_tokens bigint NOT NULL DEFAULT 0,
    usd numeric(12, 6),
    unpriced boolean NOT NULL DEFAULT false,
    pi_cost_usd numeric(12, 6),
    model_breakdown jsonb NOT NULL DEFAULT '[]'::jsonb,
    terminal_status text NOT NULL,
    occurred_at timestamp with time zone DEFAULT now() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT run_usage_run_unique UNIQUE (run_id)
);

-- migrate:down

-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.run_usage;
