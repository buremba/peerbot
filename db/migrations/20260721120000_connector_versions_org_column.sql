-- migrate:up

-- connector_versions is a global artifact cache keyed (connector_key, version):
-- correct for bundled connectors (identical bytes for every org) but a
-- cross-org collision surface for org-uploaded source (#2045 follow-up — two
-- orgs writing different code under the same key+version last-writer-win on
-- one shared row). organization_id scopes org-uploaded artifacts to their
-- owner: NULL = shared bundled row (source_path pointer into the on-disk
-- catalog), non-NULL = that org's private bytes, shadowing the shared row for
-- that org only. Nullable + no backfill: every existing row stays a shared
-- row; the dual-write rollout populates org rows going forward and a later
-- backfill attributes retained custom rows to their owning org.
ALTER TABLE public.connector_versions
  ADD COLUMN IF NOT EXISTS organization_id text;

-- migrate:down

ALTER TABLE public.connector_versions
  DROP COLUMN IF EXISTS organization_id;
