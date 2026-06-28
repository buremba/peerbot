-- migrate:up

-- Per-(org, connection) ACL enforcement state — the single switch the
-- visibility gate reads to decide "is this connection's data access-controlled
-- yet?" A connection is ENFORCED (per-user channel gating active) only when
-- `acl_support = 'full'` AND `freshness_state = 'fresh'`. Anything else (no row,
-- partial support, stale/unknown/failed freshness) means the gate does NOT
-- restrict this connection's rows beyond the existing per-agent fence — so a
-- connector whose ACL compiler hasn't run (or has gone stale) never silently
-- enforces a half-built graph. This is decision 5/7 of the authz program
-- (docs/plans/authz-acl-permission-program.md): "rollout = the permanent model,
-- not a flag"; the (acl_support, freshness_state) pair IS that data.
--
-- buildSlackChannelGraph stamps a row here ('full','fresh') once it has
-- materialized a workspace's channel membership graph. Later milestones add the
-- freshness reconcile job that flips stale connections back to 'stale'.
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
