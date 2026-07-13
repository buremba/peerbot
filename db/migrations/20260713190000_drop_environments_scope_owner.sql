-- migrate:up
--
-- Drop the vestigial per-user ownership fields on `environments`. `scope`
-- ('org'|'private') and `owner_user_id` were carried from the original
-- Environments feature (#1618) but were never wired: no UI sets them, and no
-- runtime / exec / route path ever gated on them. Private per-user credentials
-- come from OAuth connections, not an environment scope. Removing them
-- collapses `environments` to what it actually is — org-level sandbox-provider
-- config. Low-row-count admin table; the brief lock is negligible.

ALTER TABLE public.environments
  DROP CONSTRAINT IF EXISTS environments_scope_check;

-- squawk-ignore ban-drop-column -- vestigial, never read (no UI/route/exec gate); org-level admin table, low row count
ALTER TABLE public.environments
  DROP COLUMN IF EXISTS scope;

-- squawk-ignore ban-drop-column -- vestigial, never read (no UI/route/exec gate); org-level admin table, low row count
ALTER TABLE public.environments
  DROP COLUMN IF EXISTS owner_user_id;

-- migrate:down
ALTER TABLE public.environments
  ADD COLUMN IF NOT EXISTS scope text NOT NULL DEFAULT 'org';

ALTER TABLE public.environments
  ADD COLUMN IF NOT EXISTS owner_user_id text;

ALTER TABLE public.environments
  DROP CONSTRAINT IF EXISTS environments_scope_check;

-- Add the CHECK NOT VALID then VALIDATE separately so the rollback doesn't take
-- a validating table-scan lock (all existing rows default to 'org', so the
-- validation pass is trivially satisfied).
ALTER TABLE public.environments
  ADD CONSTRAINT environments_scope_check CHECK (scope IN ('org', 'private')) NOT VALID;

-- squawk-ignore prefer-robust-stmts -- rollback path; low row count
ALTER TABLE public.environments
  VALIDATE CONSTRAINT environments_scope_check;
