-- migrate:up

-- The hosted-preview cross-org resolution (resolveBoundChannelRows branch B,
-- and the inbound getBindingAnyOrg path) trusts a connection marked
-- `settings.previewMode = true` with no `metadata.teamId` to serve bindings
-- ACROSS orgs. That is only safe if there is exactly ONE such connection per
-- platform — otherwise resolution is ambiguous (which bot posts?) and, worse, a
-- tenant who set previewMode on their own team-less connection could be picked
-- to serve another org's binding. This partial unique index makes a second
-- preview connection per platform impossible, so the single hosted bot owns the
-- slot and the cross-org trust has a hard, DB-enforced single subject.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_preview_connection_per_platform
    ON public.agent_connections (platform)
    WHERE settings->'previewMode' = 'true'::jsonb
      AND (metadata->>'teamId') IS NULL;

-- migrate:down

DROP INDEX IF EXISTS public.uniq_preview_connection_per_platform;
