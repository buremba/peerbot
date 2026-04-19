-- migrate:up

CREATE TABLE public.mcp_sessions (
    session_id text PRIMARY KEY,
    user_id text,
    client_id text,
    organization_id text,
    member_role text,
    requested_agent_id text,
    is_authenticated boolean DEFAULT false NOT NULL,
    scoped_to_org boolean DEFAULT false NOT NULL,
    last_accessed_at timestamp with time zone DEFAULT now() NOT NULL,
    expires_at timestamp with time zone NOT NULL
);

CREATE INDEX mcp_sessions_client_id_idx ON public.mcp_sessions USING btree (client_id);
CREATE INDEX mcp_sessions_expires_at_idx ON public.mcp_sessions USING btree (expires_at);
CREATE INDEX mcp_sessions_user_id_idx ON public.mcp_sessions USING btree (user_id);

ALTER TABLE ONLY public.mcp_sessions
    ADD CONSTRAINT mcp_sessions_client_id_fkey FOREIGN KEY (client_id) REFERENCES public.oauth_clients(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.mcp_sessions
    ADD CONSTRAINT mcp_sessions_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE;

ALTER TABLE ONLY public.mcp_sessions
    ADD CONSTRAINT mcp_sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE;

COMMENT ON TABLE public.mcp_sessions IS 'Persisted MCP streamable HTTP sessions for restart and cross-replica recovery';

-- migrate:down

DROP TABLE IF EXISTS public.mcp_sessions;
