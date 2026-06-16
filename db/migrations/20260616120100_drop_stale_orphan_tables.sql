-- migrate:up

-- Drop two orphan tables left behind by the Redis->Postgres migration (#452)
-- and never wired back up. The #908 squash already removed them from the
-- baseline, so fresh DBs don't have them — only long-lived prod still carries
-- the physical tables (this migration converges prod with the schema; it's a
-- no-op everywhere else via IF EXISTS).
--
--   entity_read_grant  — 0 rows in prod; zero references across server, core,
--                        and the owletto frontend.
--   mcp_proxy_sessions — 0 rows in prod; referenced only in landing docs, no
--                        runtime code path.
--
-- Both are empty, so the DROP is an instant metadata operation.

DROP TABLE IF EXISTS public.entity_read_grant;
DROP TABLE IF EXISTS public.mcp_proxy_sessions;

-- migrate:down

-- Faithful restore from prod's pre-drop DDL (reverses up; on a fresh DB this
-- recreates the orphan, which is the price of a reversible migration).

CREATE TABLE IF NOT EXISTS public.mcp_proxy_sessions (
    session_key text NOT NULL,
    upstream_session_id text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT mcp_proxy_sessions_pkey PRIMARY KEY (session_key)
);
CREATE INDEX IF NOT EXISTS mcp_proxy_sessions_expires_at_idx
    ON public.mcp_proxy_sessions (expires_at);

CREATE TABLE IF NOT EXISTS public.entity_read_grant (
    id text NOT NULL,
    grantor_org_id text NOT NULL,
    entity_id bigint NOT NULL,
    grantee_user_id text NOT NULL,
    scope text DEFAULT 'read-once'::text NOT NULL,
    expires_at timestamp with time zone NOT NULL,
    single_use boolean DEFAULT true NOT NULL,
    consumed_at timestamp with time zone,
    triggering_relationship_id bigint,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT entity_read_grant_pkey PRIMARY KEY (id),
    CONSTRAINT entity_read_grant_scope_check CHECK (scope = ANY (ARRAY['read-once'::text, 'read-n'::text, 'read-window'::text])),
    CONSTRAINT entity_read_grant_entity_id_fkey FOREIGN KEY (entity_id) REFERENCES public.entities(id) ON DELETE CASCADE,
    CONSTRAINT entity_read_grant_grantee_user_id_fkey FOREIGN KEY (grantee_user_id) REFERENCES public."user"(id) ON DELETE CASCADE,
    CONSTRAINT entity_read_grant_grantor_org_id_fkey FOREIGN KEY (grantor_org_id) REFERENCES public.organization(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_entity_read_grant_entity_active
    ON public.entity_read_grant (entity_id, expires_at) WHERE consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_entity_read_grant_grantee_entity_active
    ON public.entity_read_grant (grantee_user_id, entity_id, expires_at) WHERE consumed_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_entity_read_grant_idempotency
    ON public.entity_read_grant (grantor_org_id, entity_id, grantee_user_id, triggering_relationship_id) WHERE consumed_at IS NULL;
