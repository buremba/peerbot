-- migrate:up

-- Org default inference provider. When an agent has no `defaultModel` and a
-- behavior sets no per-run model override, model resolution falls through to the
-- org's default provider — its `capabilities.text.model` becomes the effective
-- model. This is the tail of the layered fallback `behavior → agent → org`.
--
-- At most ONE live default per org: a partial unique index (mirroring
-- `inference_providers_org_slug_live`) enforces it at the DB floor, so no write
-- path (app, backfill, raw update) can leave two defaults live.

ALTER TABLE public.inference_providers
    ADD COLUMN IF NOT EXISTS is_default boolean NOT NULL DEFAULT false;

-- squawk-ignore require-concurrent-index-creation -- partial unique over a tiny per-org table; dbmate wraps in a transaction
CREATE UNIQUE INDEX IF NOT EXISTS inference_providers_org_default_live
    ON public.inference_providers (organization_id)
    WHERE (is_default AND deleted_at IS NULL);

-- migrate:down

-- squawk-ignore require-concurrent-index-deletion -- down runs inside dbmate's txn; CONCURRENTLY can't run in a transaction
DROP INDEX IF EXISTS inference_providers_org_default_live;

ALTER TABLE public.inference_providers
    DROP COLUMN IF EXISTS is_default;
