-- migrate:up

-- Per-(org, connection) ACL enforcement state — the single switch the
-- visibility gate reads to decide "is this connection's data access-controlled
-- yet?" A connection is ENFORCED (per-user channel gating active) only when
-- `acl_support = 'full'` AND `freshness_state = 'fresh'` AND the graph was synced
-- recently (the gate ages out a `fresh` row past its staleness window). The two
-- cases differ:
--   * NO row at all (connection never graphed) → the gate leaves this
--     connection on the existing per-agent fence, so a connector whose ACL
--     compiler has never run is never silently half-enforced.
--   * A row in ANY non-enforcing state (partial support, or stale/unknown/failed
--     freshness, or a `fresh` row aged past the window) → the gate FAILS CLOSED:
--     it drops the connection's channels rather than reverting to legacy, because
--     an onboarded connection whose graph goes stale must not silently re-expose
--     every channel.
-- This is decision 5/7 of the authz program
-- (docs/plans/authz-acl-permission-program.md): "rollout = the permanent model,
-- not a flag"; the (acl_support, freshness_state, last_synced_at) triple IS that
-- data.
--
-- buildSlackChannelGraph stamps a row here ('full','fresh', now()) once it has
-- materialized a workspace's channel membership graph; the periodic
-- authz-acl-sync tick re-stamps last_synced_at, and the gate's age window flips a
-- connection fail-closed if that tick stops.
CREATE TABLE IF NOT EXISTS public.authz_source_acl_state (
    organization_id text NOT NULL,
    connection_id text NOT NULL,
    -- How completely this connection's ACLs are modeled: none | partial | full.
    acl_support text NOT NULL DEFAULT 'none',
    -- Confidence the modeled ACLs reflect the source right now:
    -- fresh | stale | unknown | failed. The gate fails closed on anything but
    -- 'fresh'.
    freshness_state text NOT NULL DEFAULT 'unknown',
    -- When the ACL graph for this connection was last (re)materialized.
    last_synced_at timestamp with time zone,
    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),
    CONSTRAINT authz_source_acl_state_pkey PRIMARY KEY (organization_id, connection_id),
    CONSTRAINT authz_source_acl_state_acl_support_check
        CHECK (acl_support IN ('none', 'partial', 'full')),
    CONSTRAINT authz_source_acl_state_freshness_check
        CHECK (freshness_state IN ('fresh', 'stale', 'unknown', 'failed'))
);

-- migrate:down

-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.authz_source_acl_state;
