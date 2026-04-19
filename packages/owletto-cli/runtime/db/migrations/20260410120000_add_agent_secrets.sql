-- migrate:up

CREATE TABLE public.agent_secrets (
    name text PRIMARY KEY,
    ciphertext text NOT NULL,
    expires_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);

-- text_pattern_ops index enables efficient prefix scans used by list(prefix)
-- to support cascade deletes (deleteSecretsByPrefix in @lobu/gateway).
CREATE INDEX agent_secrets_name_prefix_idx
    ON public.agent_secrets USING btree (name text_pattern_ops);

CREATE INDEX agent_secrets_expires_at_idx
    ON public.agent_secrets USING btree (expires_at)
    WHERE expires_at IS NOT NULL;

COMMENT ON TABLE public.agent_secrets IS
    'Encrypted secret values referenced via secret:// refs. Backs the PostgresSecretStore implementation of @lobu/gateway WritableSecretStore.';

-- migrate:down

DROP TABLE IF EXISTS public.agent_secrets;
