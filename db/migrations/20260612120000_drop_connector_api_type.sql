-- migrate:up

-- Contract phase of #1042 (tracked in #1044): the 'browser'/'api' worker-claim
-- axis was removed and no code reads or writes connector_definitions.api_type.
-- Expand/contract: #1042 has been deployed for weeks, so no running replica
-- references the column and dropping it is safe under a rolling upgrade.
ALTER TABLE public.connector_definitions DROP COLUMN IF EXISTS api_type;

-- migrate:down

ALTER TABLE public.connector_definitions
    ADD COLUMN IF NOT EXISTS api_type text DEFAULT 'api'::text NOT NULL;
