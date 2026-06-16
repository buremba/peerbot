-- migrate:up

-- oauth_tokens index hygiene. The table is small (~10 MB / ~12k rows), so plain
-- index builds take a brief SHARE lock measured in milliseconds — no need for
-- CONCURRENTLY here, and a normal transaction lets all three statements share
-- one migration.
--
--   parent_token_id / organization_id — FK columns with no supporting index;
--       Postgres doesn't auto-index the referencing side, so parent/org deletes
--       seq-scan + lock the table.
--   oauth_tokens_token_hash_idx — plain btree on token_hash that fully
--       duplicates the UNIQUE oauth_tokens_token_hash_key on the same column;
--       drop the redundant copy (DROP INDEX is a catalog-only operation).

CREATE INDEX IF NOT EXISTS oauth_tokens_parent_token_id_idx
    ON public.oauth_tokens (parent_token_id);

CREATE INDEX IF NOT EXISTS oauth_tokens_organization_id_idx
    ON public.oauth_tokens (organization_id);

DROP INDEX IF EXISTS public.oauth_tokens_token_hash_idx;

-- migrate:down

CREATE INDEX IF NOT EXISTS oauth_tokens_token_hash_idx
    ON public.oauth_tokens (token_hash);

DROP INDEX IF EXISTS public.oauth_tokens_organization_id_idx;
DROP INDEX IF EXISTS public.oauth_tokens_parent_token_id_idx;
