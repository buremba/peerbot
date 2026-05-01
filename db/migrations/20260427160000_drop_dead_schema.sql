-- migrate:up

-- Drop schema objects that have no readers, writers, or references in the
-- TypeScript source tree (`packages/server/src` is the source of
-- truth — `owletto-cli/runtime` is a generated mirror).
--
-- Verification:
--   * Strict SQL grep across packages/{server,gateway,worker,
--     web,connector-sdk}/src for FROM/JOIN/INSERT/UPDATE/REFERENCES.
--   * `query_sql` allowlist (utils/table-schema.ts) does not list any of
--     the dropped tables, columns, or the view.
--   * better-auth `teams` is not enabled in src/auth/index.tsx, so the
--     `team` table and `member.teamId` are unused at runtime.
--   * `verification` is intentionally NOT dropped — better-auth's
--     magicLink and phoneNumber plugins write OTPs/tokens there.
--
-- Idempotent (DROP IF EXISTS) so it is safe whether the object exists or
-- was already removed out-of-band.

-- ---------------------------------------------------------------------------
-- Tables: empty in prod, no code paths reference them
-- ---------------------------------------------------------------------------

DROP TABLE IF EXISTS public.rate_limits;
DROP TABLE IF EXISTS public.workers;
DROP TABLE IF EXISTS public.source_type_auth_defaults;
DROP TABLE IF EXISTS public.workspace_settings;

-- `team` is referenced by `member.teamId`. Drop the inbound FK + column
-- first so the table drop does not depend on CASCADE behavior.
ALTER TABLE public.member DROP CONSTRAINT IF EXISTS "member_teamId_fkey";
ALTER TABLE public.member DROP COLUMN IF EXISTS "teamId";
DROP TABLE IF EXISTS public.team;

-- ---------------------------------------------------------------------------
-- Views: defined in baseline, not referenced anywhere in code
-- ---------------------------------------------------------------------------

DROP VIEW IF EXISTS public.event_thread_tree;

-- ---------------------------------------------------------------------------
-- Columns: always-NULL in prod, never read or written by any code path
-- ---------------------------------------------------------------------------

ALTER TABLE public.watchers
  DROP COLUMN IF EXISTS lobu_schedule_id,
  DROP COLUMN IF EXISTS registry_ref,
  DROP COLUMN IF EXISTS registry_repo,
  DROP COLUMN IF EXISTS registry_type;

-- watcher_versions.source_path is unused (the heavily-used `source_path`
-- column lives on connector_versions; same name, different table).
ALTER TABLE public.watcher_versions
  DROP COLUMN IF EXISTS source_path,
  DROP COLUMN IF EXISTS source_repository,
  DROP COLUMN IF EXISTS source_ref,
  DROP COLUMN IF EXISTS source_commit_sha,
  DROP COLUMN IF EXISTS sources_schema;

ALTER TABLE public.connector_versions
  DROP COLUMN IF EXISTS source_repository,
  DROP COLUMN IF EXISTS source_ref,
  DROP COLUMN IF EXISTS source_commit_sha;

ALTER TABLE public.event_embeddings
  DROP COLUMN IF EXISTS model_key;


-- migrate:down

-- This cleanup is one-way. Re-creating these objects would require copying
-- DDL from the baseline migration (00000000000000_baseline.sql) and the
-- column definitions inferred from prior schema dumps. Down is intentionally
-- a no-op — recovery is via `git revert` of this migration plus manual DDL,
-- not via dbmate rollback.
SELECT 1;
