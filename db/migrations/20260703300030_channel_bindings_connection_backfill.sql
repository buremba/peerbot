-- migrate:up

-- All binding read paths now key on connection_id, so any row the 20260629
-- resync left NULL silently stops routing/recalling. That resync only linked
-- ACTIVE same-org connections; close the two gaps it left. The table is small
-- (per-org channel links), so inline UPDATEs are safe.

-- Gap 1: same-org connections that were paused/errored at resync time. Same
-- match rule as the resync, minus the status filter (prefer active rows).
UPDATE public.agent_channel_bindings b
SET connection_id = (
    SELECT c.id FROM public.connections c
    WHERE c.deleted_at IS NULL
      AND c.credential_mode IS NOT NULL
      AND c.organization_id = b.organization_id
      AND c.connector_key = b.platform
      AND (
          (b.team_id IS NOT NULL AND c.external_tenant_id = b.team_id)
          OR (b.team_id IS NULL AND c.external_tenant_id IS NULL AND c.agent_id = b.agent_id)
      )
    ORDER BY (c.status = 'active') DESC, c.updated_at DESC
    LIMIT 1
)
WHERE b.connection_id IS NULL
  AND EXISTS (
      SELECT 1 FROM public.connections c
      WHERE c.deleted_at IS NULL
        AND c.credential_mode IS NOT NULL
        AND c.organization_id = b.organization_id
        AND c.connector_key = b.platform
        AND (
            (b.team_id IS NOT NULL AND c.external_tenant_id = b.team_id)
            OR (b.team_id IS NULL AND c.external_tenant_id IS NULL AND c.agent_id = b.agent_id)
        )
  );

-- Gap 2: hosted-preview links — the binding row lives in the claiming org but
-- the bot connection lives in the preview org, so the same-org rule above can
-- never link them. Link cross-org only when the (platform, team) tuple
-- resolves to exactly ONE connection anywhere; ambiguous tuples stay NULL,
-- stop routing, and are reported below for a one-time manual patch (pick the
-- connection that actually served the binding and set connection_id by hand).
UPDATE public.agent_channel_bindings b
SET connection_id = (
    SELECT c.id FROM public.connections c
    WHERE c.deleted_at IS NULL
      AND c.credential_mode IS NOT NULL
      AND c.connector_key = b.platform
      AND c.external_tenant_id = b.team_id
)
WHERE b.connection_id IS NULL
  AND b.team_id IS NOT NULL
  AND (
      SELECT count(*) FROM public.connections c
      WHERE c.deleted_at IS NULL
        AND c.credential_mode IS NOT NULL
        AND c.connector_key = b.platform
        AND c.external_tenant_id = b.team_id
  ) = 1;

-- Surface what could not be linked: these rows no longer route until patched.
DO $$
DECLARE
  orphaned integer;
BEGIN
  SELECT count(*) INTO orphaned
  FROM public.agent_channel_bindings
  WHERE connection_id IS NULL;
  IF orphaned > 0 THEN
    RAISE WARNING
      'channel_bindings_connection_backfill: % binding row(s) still have connection_id IS NULL (ambiguous (platform, team) tuple) — these do not route; patch connection_id manually',
      orphaned;
  END IF;
END
$$;

-- migrate:down

-- No-op: distinguishing rows linked here from organically linked ones is not
-- possible after the fact, and unlinking would only re-break routing.
SELECT 1;
