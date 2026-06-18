-- migrate:up

-- agent_grants was superseded by public.grants (GrantStore). Data was copied
-- in 20260618140000_migrate_agent_grants_to_grants; this drops the orphan.
-- IF EXISTS: fresh DBs post-squash may never have had the table.

DROP TABLE IF EXISTS public.agent_grants;

-- migrate:down

CREATE TABLE IF NOT EXISTS public.agent_grants (
    id bigint NOT NULL,
    agent_id text NOT NULL,
    pattern text NOT NULL,
    expires_at timestamp with time zone,
    granted_at timestamp with time zone DEFAULT now() NOT NULL,
    denied boolean DEFAULT false,
    organization_id text NOT NULL
);

ALTER TABLE public.agent_grants ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.agent_grants_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

ALTER TABLE ONLY public.agent_grants
    ADD CONSTRAINT agent_grants_pkey PRIMARY KEY (id);

ALTER TABLE ONLY public.agent_grants
    ADD CONSTRAINT agent_grants_org_agent_pattern_key
    UNIQUE (organization_id, agent_id, pattern);

CREATE INDEX IF NOT EXISTS agent_grants_agent_id_idx
    ON public.agent_grants USING btree (agent_id);

CREATE INDEX IF NOT EXISTS agent_grants_org_agent_idx
    ON public.agent_grants USING btree (organization_id, agent_id);

ALTER TABLE ONLY public.agent_grants
    ADD CONSTRAINT agent_grants_org_agent_fkey
    FOREIGN KEY (organization_id, agent_id)
    REFERENCES public.agents(organization_id, id) ON DELETE CASCADE;