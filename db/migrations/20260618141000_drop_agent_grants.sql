-- migrate:up

-- Remove obsolete duplicate grant storage. Runtime permission enforcement uses
-- public.grants via GrantStore; public.agent_grants is intentionally discarded.
SET lock_timeout = '1s';
SET statement_timeout = '5s';
-- squawk-ignore ban-drop-table
DROP TABLE IF EXISTS public.agent_grants;
RESET statement_timeout;
RESET lock_timeout;

-- migrate:down

-- Irreversible: public.agent_grants was obsolete duplicate storage and is not
-- recreated on rollback.
