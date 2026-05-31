-- migrate:up

-- Defense-in-depth backstop for the member-accessible query_sql / metric_series.
-- Non-admin callers run their (already org-scoped, already app-gated) SQL under
-- this role via `SET LOCAL ROLE`. The role can read every queryable table EXCEPT
-- the auth/identity tables, so if a parser hole ever lets an admin-only table
-- slip past the app-layer gate, PostgreSQL itself refuses with "permission
-- denied". Cross-org isolation is still enforced by the org-scoping CTEs — this
-- role is purely a table-level backstop on the highest-value tables.
--
-- The REVOKE list MUST stay in sync with ADMIN_ONLY_QUERYABLE_TABLES in
-- packages/server/src/utils/table-schema.ts.
--
-- Everything is wrapped so a deploy NEVER fails when the DB user lacks
-- CREATEROLE (e.g. a managed prod cluster). If the role can't be created, the
-- runtime detects its absence and falls back to the app-layer gate alone.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lobu_query_restricted') THEN
    CREATE ROLE lobu_query_restricted NOLOGIN;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'lobu_query_restricted: CREATE ROLE skipped (insufficient privilege); app-layer gate remains the control';
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lobu_query_restricted') THEN
    GRANT USAGE ON SCHEMA public TO lobu_query_restricted;
    GRANT SELECT ON ALL TABLES IN SCHEMA public TO lobu_query_restricted;
    -- cover tables added by future migrations (run as this same user)
    ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO lobu_query_restricted;
    -- ...but never the auth/identity tables (keep in sync with ADMIN_ONLY_QUERYABLE_TABLES)
    REVOKE SELECT ON public.oauth_tokens, public.oauth_clients, public."user"
      FROM lobu_query_restricted;
    -- let the app user assume the role for member queries
    EXECUTE format('GRANT lobu_query_restricted TO %I', current_user);
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'lobu_query_restricted: grants skipped (insufficient privilege)';
END $$;

-- migrate:down

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'lobu_query_restricted') THEN
    ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE SELECT ON TABLES FROM lobu_query_restricted;
    REVOKE ALL ON ALL TABLES IN SCHEMA public FROM lobu_query_restricted;
    REVOKE USAGE ON SCHEMA public FROM lobu_query_restricted;
    EXECUTE format('REVOKE lobu_query_restricted FROM %I', current_user);
    DROP ROLE lobu_query_restricted;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'lobu_query_restricted: down-migration cleanup skipped';
END $$;
