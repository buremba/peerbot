-- migrate:up

-- Marketplace / Slack-initiated installs arrive with a bot token but no Lobu org
-- (the installer hasn't identified themselves in Lobu yet). Park them as an
-- unclaimed `pending` app_installations row — org-less — until an admin claims
-- the workspace by signing in with Slack. Routing already ignores non-`active`
-- rows (`resolveActiveByTenant` filters status='active'; the active-tenant unique
-- index is partial on active), so a pending row is inert until claimed.
--
-- The only blocker to reusing app_installations for this was organization_id
-- NOT NULL. Relax it, but keep the invariant explicit: org may be null ONLY while
-- the row is pending. On claim, the org is set and status flips to active.

ALTER TABLE public.app_installations
    ALTER COLUMN organization_id DROP NOT NULL;

-- NOT VALID first so we don't take an ACCESS EXCLUSIVE full-table scan lock;
-- VALIDATE separately takes only a lighter SHARE UPDATE EXCLUSIVE lock.
ALTER TABLE public.app_installations
    ADD CONSTRAINT app_installations_org_or_pending
    CHECK (organization_id IS NOT NULL OR status = 'pending') NOT VALID;

ALTER TABLE public.app_installations
    VALIDATE CONSTRAINT app_installations_org_or_pending;

-- migrate:down

ALTER TABLE public.app_installations
    DROP CONSTRAINT IF EXISTS app_installations_org_or_pending;

-- Backfill guard: DROP NOT NULL is only reversible if no null orgs remain.
-- Pending/unclaimed rows must be cleared before reverting (they have null org).
DELETE FROM public.app_installations WHERE organization_id IS NULL;

ALTER TABLE public.app_installations
    ALTER COLUMN organization_id SET NOT NULL;
