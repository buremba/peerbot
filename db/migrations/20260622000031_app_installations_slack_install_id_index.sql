-- migrate:up transaction:false

-- External-id lookup support for installs that route by a durable string id
-- distinct from the bigint PK. Slack OAuth installs keep their stable
-- `slackinst-<uuid>` id (it is the secret-store name prefix
-- `installations/<id>/botToken` AND the chat-instance-manager memo / webhook
-- routing key — see SLACK_INSTALLATION_ID_PREFIX). That id is NOT the
-- app_installations bigint PK; it lives in `metadata->>'external_id'`. The Slack
-- install projection resolves a row by that id, so index it.
--
-- Partial (provider='slack' rows only) + on the JSON-extracted text so the lookup
-- is a single index probe instead of a metadata scan. CONCURRENTLY so the build
-- never blocks installs on a populated table; one statement per transaction:false
-- migration (dbmate sends the block as one simple-query batch and CONCURRENTLY
-- can't run inside the implicit transaction a multi-statement batch gets).
CREATE INDEX CONCURRENTLY IF NOT EXISTS app_installations_slack_external_id
    ON public.app_installations ((metadata ->> 'external_id'))
    WHERE provider = 'slack';

-- migrate:down transaction:false

DROP INDEX CONCURRENTLY IF EXISTS public.app_installations_slack_external_id;
