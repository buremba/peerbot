-- migrate:up
-- Drop chat_connections table. Connection state is now unified in
-- agent_connections, which ChatInstanceManager reads/writes directly.
-- Secret fields (botToken, signingSecret, etc.) live as `secret://`
-- refs inside the row's `config` JSON and resolve at runtime through
-- SecretStoreRegistry — backed by Postgres by default, pluggable to
-- AWS Secrets Manager / Vault / k8s for ops who need it.

-- Copy any existing chat_connections rows into agent_connections so a
-- live deployment with provisioned chat bots doesn't lose them. Configs
-- carrying the legacy `enc:v1:` ciphertext are handled at read time by
-- decryptLegacyEncryptedConfig in postgres-stores.ts; refs pass through
-- unchanged. ON CONFLICT DO NOTHING covers the case where rows have
-- already been mirrored by an in-flight write through the manager.
-- agent_connections.agent_id is NOT NULL, but chat_connections.template_agent_id
-- was nullable. Skip orphaned rows (no parent agent) — they could not start
-- in the current model anyway.
-- Guarded by to_regclass: deployments that never had chat_connections
-- (table created with IF NOT EXISTS in 20260429140000 and never used) skip
-- the copy entirely instead of erroring on the missing relation.
DO $$
BEGIN
    IF to_regclass('public.chat_connections') IS NOT NULL THEN
        INSERT INTO public.agent_connections (
            id, agent_id, platform, config, settings, metadata,
            status, error_message, created_at, updated_at
        )
        SELECT
            id, template_agent_id, platform, config, settings, metadata,
            status, error_message, created_at, updated_at
        FROM public.chat_connections
        WHERE template_agent_id IS NOT NULL
        ON CONFLICT (id) DO NOTHING;
    END IF;
END $$;

DROP TABLE IF EXISTS public.chat_connections;

-- migrate:down
-- Recreate chat_connections for rollback. Data would need to be re-seeded.

CREATE TABLE IF NOT EXISTS public.chat_connections (
    id text PRIMARY KEY,
    platform text NOT NULL,
    template_agent_id text REFERENCES public.agents(id) ON DELETE CASCADE,
    config jsonb NOT NULL,
    settings jsonb NOT NULL DEFAULT '{}'::jsonb,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    status text NOT NULL DEFAULT 'active',
    error_message text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS chat_connections_template_agent_id_idx
    ON public.chat_connections (template_agent_id)
    WHERE template_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS chat_connections_platform_idx
    ON public.chat_connections (platform);
