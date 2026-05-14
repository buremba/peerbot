/**
 * Embedded (PGlite) schema patches.
 *
 * Already-initialized embedded/PGlite databases skip the dbmate migrations
 * directory runner, so schema changes that ship as `db/migrations/*.sql` are
 * mirrored here as idempotent ALTER/CREATE statements and replayed on every
 * boot. Pure data — the runner lives in `start-local.ts`.
 */

export type MigrationSqlClient = {
  unsafe: (...args: any[]) => Promise<unknown>;
};

export interface EmbeddedSchemaPatch {
  id: string;
  apply: (sql: MigrationSqlClient) => Promise<void>;
}

export const EMBEDDED_SCHEMA_PATCHES: EmbeddedSchemaPatch[] = [
  {
    id: 'feeds-display-name',
    apply: async (sql) => {
      await sql.unsafe(`
        ALTER TABLE public.feeds
        ADD COLUMN IF NOT EXISTS display_name text
      `);
    },
  },
  {
    id: 'watcher-run-correlation',
    apply: async (sql) => {
      await sql.unsafe(`
        ALTER TABLE public.runs
        ADD COLUMN IF NOT EXISTS dispatched_message_id text
      `);
      await sql.unsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_dispatched_message_id
        ON public.runs (dispatched_message_id)
        WHERE dispatched_message_id IS NOT NULL
      `);
      await sql.unsafe(`
        ALTER TABLE public.watcher_windows
        ADD COLUMN IF NOT EXISTS run_id bigint
        REFERENCES public.runs(id) ON DELETE SET NULL
      `);
      await sql.unsafe(`
        WITH correlated_windows AS (
          SELECT ww.id,
                 (btrim(ww.run_metadata->>'watcher_run_id'))::bigint AS correlated_run_id
          FROM public.watcher_windows ww
          WHERE ww.run_id IS NULL
            AND ww.run_metadata ? 'watcher_run_id'
            AND jsonb_typeof(ww.run_metadata->'watcher_run_id') IN ('number', 'string')
            AND btrim(ww.run_metadata->>'watcher_run_id') ~ '^[0-9]+$'
        )
        UPDATE public.watcher_windows ww
        SET run_id = cw.correlated_run_id
        FROM correlated_windows cw
        WHERE ww.id = cw.id
          AND EXISTS (
            SELECT 1
            FROM public.runs r
            WHERE r.id = cw.correlated_run_id
              AND r.run_type = 'watcher'
          )
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_watcher_windows_run_id
        ON public.watcher_windows (run_id)
        WHERE run_id IS NOT NULL
      `);
    },
  },
  {
    id: 'mcp-sessions-table',
    apply: async (sql) => {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS public.mcp_sessions (
          session_id text PRIMARY KEY,
          user_id text,
          client_id text,
          organization_id text,
          member_role text,
          requested_agent_id text,
          is_authenticated boolean DEFAULT false NOT NULL,
          scoped_to_org boolean DEFAULT false NOT NULL,
          last_accessed_at timestamp with time zone DEFAULT now() NOT NULL,
          expires_at timestamp with time zone NOT NULL
        )
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS mcp_sessions_client_id_idx
        ON public.mcp_sessions USING btree (client_id)
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS mcp_sessions_expires_at_idx
        ON public.mcp_sessions USING btree (expires_at)
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS mcp_sessions_user_id_idx
        ON public.mcp_sessions USING btree (user_id)
      `);
      await sql.unsafe(`
        ALTER TABLE public.mcp_sessions
        DROP CONSTRAINT IF EXISTS mcp_sessions_client_id_fkey
      `);
      await sql.unsafe(`
        ALTER TABLE public.mcp_sessions
        ADD CONSTRAINT mcp_sessions_client_id_fkey
        FOREIGN KEY (client_id) REFERENCES public.oauth_clients(id) ON DELETE CASCADE
      `);
      await sql.unsafe(`
        ALTER TABLE public.mcp_sessions
        DROP CONSTRAINT IF EXISTS mcp_sessions_organization_id_fkey
      `);
      await sql.unsafe(`
        ALTER TABLE public.mcp_sessions
        ADD CONSTRAINT mcp_sessions_organization_id_fkey
        FOREIGN KEY (organization_id) REFERENCES public.organization(id) ON DELETE CASCADE
      `);
      await sql.unsafe(`
        ALTER TABLE public.mcp_sessions
        DROP CONSTRAINT IF EXISTS mcp_sessions_user_id_fkey
      `);
      await sql.unsafe(`
        ALTER TABLE public.mcp_sessions
        ADD CONSTRAINT mcp_sessions_user_id_fkey
        FOREIGN KEY (user_id) REFERENCES public."user"(id) ON DELETE CASCADE
      `);
    },
  },
  {
    id: 'agent-secrets-org-scope',
    apply: async (sql) => {
      // Mirror of db/migrations/20260503000000_agent_secrets_org_scope.sql
      // for already-initialized PGlite installs that skip the migrations
      // dir runner.
      await sql.unsafe(`
        ALTER TABLE public.agent_secrets
        ADD COLUMN IF NOT EXISTS organization_id text NOT NULL DEFAULT ''
      `);
      await sql.unsafe(`
        ALTER TABLE public.agent_secrets
        DROP CONSTRAINT IF EXISTS agent_secrets_pkey
      `);
      await sql.unsafe(`
        ALTER TABLE public.agent_secrets
        ADD CONSTRAINT agent_secrets_pkey PRIMARY KEY (organization_id, name)
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS agent_secrets_org_id_idx
        ON public.agent_secrets (organization_id)
      `);
    },
  },
  {
    id: 'drop-chat-connections',
    apply: async (sql) => {
      // Mirror of db/migrations/20260502000000_drop_chat_connections.sql
      // for already-initialized PGlite installs that skip the migrations
      // dir runner. ChatInstanceManager now reads/writes agent_connections
      // directly. Copy any rows from chat_connections (if it exists) into
      // agent_connections, then drop the legacy table. INSERT runs only
      // when chat_connections is present so fresh PGlite installs (which
      // never had the table) skip cleanly.
      await sql.unsafe(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_tables
            WHERE schemaname = 'public' AND tablename = 'chat_connections'
          ) THEN
            INSERT INTO public.agent_connections (
              id, agent_id, platform, config, settings, metadata,
              status, error_message, created_at, updated_at
            )
            SELECT
              id, template_agent_id, platform, config, settings, metadata,
              status, error_message, created_at, updated_at
            FROM public.chat_connections
            WHERE template_agent_id IS NOT NULL
            ON CONFLICT (id) DO NOTHING;

            DROP TABLE public.chat_connections;
          END IF;
        END $$;
      `);
    },
  },
  {
    id: 'connector-required-capability',
    apply: async (sql) => {
      await sql.unsafe(`
        ALTER TABLE public.connector_definitions
        ADD COLUMN IF NOT EXISTS required_capability text
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS connector_definitions_required_capability_idx
        ON public.connector_definitions (required_capability)
        WHERE required_capability IS NOT NULL
      `);
    },
  },
  {
    id: 'connector-runtime',
    apply: async (sql) => {
      // `runtime` carries platform metadata for device-bound connectors
      // (e.g. apple.screen_time / local.directory, which run inside the Lobu
      // Lobu for Mac). NULL = embedded server.
      await sql.unsafe(`
        ALTER TABLE public.connector_definitions
        ADD COLUMN IF NOT EXISTS runtime jsonb
      `);
    },
  },
  {
    id: 'device-workers',
    apply: async (sql) => {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS public.device_workers (
          user_id text NOT NULL,
          worker_id text NOT NULL,
          platform text,
          app_version text,
          capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
          label text,
          first_seen_at timestamptz NOT NULL DEFAULT now(),
          last_seen_at timestamptz NOT NULL DEFAULT now(),
          PRIMARY KEY (user_id, worker_id)
        )
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS device_workers_user_id_idx
        ON public.device_workers (user_id)
      `);
    },
  },
  {
    // Mirrors db/migrations/20260512000000_device_worker_connection_binding.sql
    // for already-initialized embedded/PGlite databases (where dbmate
    // migrations don't run).
    id: 'device-worker-connection-binding',
    apply: async (sql) => {
      await sql.unsafe(`
        ALTER TABLE public.device_workers
        ADD COLUMN IF NOT EXISTS id uuid NOT NULL DEFAULT gen_random_uuid()
      `);
      await sql.unsafe(`
        ALTER TABLE public.device_workers
        ADD COLUMN IF NOT EXISTS organization_id text
      `);
      await sql.unsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS device_workers_id_key
        ON public.device_workers (id)
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_device_workers_organization_id
        ON public.device_workers (organization_id)
        WHERE organization_id IS NOT NULL
      `);
      await sql.unsafe(`
        ALTER TABLE public.connections
        ADD COLUMN IF NOT EXISTS device_worker_id uuid
      `);
      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'connections_device_worker_id_fkey'
          ) THEN
            ALTER TABLE public.connections
              ADD CONSTRAINT connections_device_worker_id_fkey
              FOREIGN KEY (device_worker_id)
              REFERENCES public.device_workers (id)
              ON DELETE SET NULL;
          END IF;
        END $$;
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_connections_device_worker_id
        ON public.connections (device_worker_id)
        WHERE device_worker_id IS NOT NULL
      `);
      await sql.unsafe(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_connections_org_connector_device_live
        ON public.connections (organization_id, connector_key, device_worker_id)
        WHERE deleted_at IS NULL AND device_worker_id IS NOT NULL
      `);
      // Older embedded DBs may have the dropped device_worker_org_grants table.
      await sql.unsafe(`DROP TABLE IF EXISTS public.device_worker_org_grants`);
    },
  },
  {
    // Mirrors db/migrations/20260513120000_auth_profiles_device_binding.sql.
    // Lets a 'browser_session' auth_profile live on a device worker (cookies on
    // disk in user_data_dir, auth_data empty) instead of in server-side
    // auth_data jsonb.
    id: 'auth-profiles-device-binding',
    apply: async (sql) => {
      await sql.unsafe(`
        ALTER TABLE public.auth_profiles
        ADD COLUMN IF NOT EXISTS device_worker_id uuid
      `);
      await sql.unsafe(`
        ALTER TABLE public.auth_profiles
        ADD COLUMN IF NOT EXISTS browser_kind text
      `);
      await sql.unsafe(`
        ALTER TABLE public.auth_profiles
        ADD COLUMN IF NOT EXISTS user_data_dir text
      `);
      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'auth_profiles_device_worker_id_fkey'
          ) THEN
            ALTER TABLE public.auth_profiles
              ADD CONSTRAINT auth_profiles_device_worker_id_fkey
              FOREIGN KEY (device_worker_id)
              REFERENCES public.device_workers (id)
              ON DELETE CASCADE;
          END IF;
        END $$;
      `);
      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'auth_profiles_browser_kind_check'
          ) THEN
            ALTER TABLE public.auth_profiles
              ADD CONSTRAINT auth_profiles_browser_kind_check
              CHECK (browser_kind IS NULL OR browser_kind = ANY (ARRAY['chrome','brave','arc','edge']));
          END IF;
        END $$;
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS auth_profiles_device_worker_idx
        ON public.auth_profiles (device_worker_id)
        WHERE device_worker_id IS NOT NULL
      `);
    },
  },
  {
    // Mirrors db/migrations/20260513150000_auth_profiles_cdp_url.sql
    id: 'auth-profiles-cdp-url',
    apply: async (sql) => {
      await sql.unsafe(`
        ALTER TABLE public.auth_profiles
        ADD COLUMN IF NOT EXISTS cdp_url text
      `);
      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'auth_profiles_device_browser_path_xor'
          ) THEN
            ALTER TABLE public.auth_profiles
              ADD CONSTRAINT auth_profiles_device_browser_path_xor
              CHECK (
                device_worker_id IS NULL
                OR profile_kind <> 'browser_session'
                OR (
                  (user_data_dir IS NOT NULL AND cdp_url IS NULL)
                  OR (user_data_dir IS NULL AND cdp_url IS NOT NULL)
                )
              );
          END IF;
        END $$;
      `);
    },
  },
  {
    // Mirrors db/migrations/20260513200000_notifications_as_events.sql.
    // Idempotent: only migrates rows from `notifications` if the table still
    // exists; subsequent boots no-op.
    id: 'notifications-as-events',
    apply: async (sql) => {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS public.notification_targets (
          event_id bigint NOT NULL REFERENCES public.events(id) ON DELETE CASCADE,
          user_id text NOT NULL,
          delivered_at timestamp with time zone NOT NULL DEFAULT now(),
          read_at timestamp with time zone,
          PRIMARY KEY (event_id, user_id)
        )
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_notification_targets_user_unread
          ON public.notification_targets (user_id, delivered_at DESC)
          WHERE read_at IS NULL
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_notification_targets_user_all
          ON public.notification_targets (user_id, delivered_at DESC)
      `);
      // Backfill from the legacy table if it still exists.
      const legacyExists = (await sql.unsafe(
        `SELECT to_regclass('public.notifications') IS NOT NULL AS exists`
      )) as Array<{ exists: boolean }>;
      if (legacyExists[0]?.exists) {
        await sql.unsafe(`
          WITH legacy AS (
            SELECT id, organization_id, user_id, type, title, body,
                   resource_type, resource_id, resource_url, is_read, created_at
            FROM public.notifications
            ORDER BY id ASC
          ),
          inserted AS (
            INSERT INTO public.events
              (organization_id, title, payload_text, payload_type, semantic_type,
               occurred_at, created_at, metadata, origin_id)
            SELECT
              l.organization_id, l.title, l.body, 'text', 'notification',
              l.created_at, l.created_at,
              jsonb_build_object(
                'notification_type', l.type,
                'resource_type', l.resource_type,
                'resource_id', l.resource_id,
                'resource_url', l.resource_url,
                'legacy_notification_id', l.id
              ),
              'notification:legacy:' || l.id::text
            FROM legacy l
            RETURNING id AS event_id,
                      (metadata->>'legacy_notification_id')::bigint AS legacy_id
          )
          INSERT INTO public.notification_targets (event_id, user_id, delivered_at, read_at)
          SELECT i.event_id, l.user_id, l.created_at,
                 CASE WHEN l.is_read THEN l.created_at ELSE NULL END
          FROM inserted i
          JOIN public.notifications l ON l.id = i.legacy_id
        `);
        await sql.unsafe(`DROP TABLE public.notifications`);
      }
    },
  },
  {
    // Mirrors db/migrations/20260514000000_scheduled_jobs.sql.
    id: 'scheduled-jobs',
    apply: async (sql) => {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS public.scheduled_jobs (
          id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
          organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
          action_type text NOT NULL,
          action_args jsonb NOT NULL,
          cron text,
          next_run_at timestamp with time zone NOT NULL,
          last_fired_at timestamp with time zone,
          last_fired_run_id bigint,
          paused boolean NOT NULL DEFAULT false,
          description text NOT NULL,
          created_by_user text,
          created_by_agent text,
          source_run_id bigint,
          source_event_id bigint,
          source_thread_id text,
          created_at timestamp with time zone NOT NULL DEFAULT now(),
          updated_at timestamp with time zone NOT NULL DEFAULT now(),
          CONSTRAINT scheduled_jobs_attribution_check CHECK (
            created_by_user IS NOT NULL OR created_by_agent IS NOT NULL
          )
        )
      `);
      await sql.unsafe(`
        DO $$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'agents' AND relkind = 'r')
             AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_jobs_agent_fkey') THEN
            ALTER TABLE public.scheduled_jobs
              ADD CONSTRAINT scheduled_jobs_agent_fkey
              FOREIGN KEY (created_by_agent) REFERENCES public.agents(id) ON DELETE CASCADE;
          END IF;
        END$$;
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_due
          ON public.scheduled_jobs (next_run_at) WHERE NOT paused
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_org_agent
          ON public.scheduled_jobs (organization_id, created_by_agent)
          WHERE created_by_agent IS NOT NULL
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_org_user
          ON public.scheduled_jobs (organization_id, created_by_user)
          WHERE created_by_user IS NOT NULL
      `);
    },
  },
  {
    // Mirrors db/migrations/20260514120000_auth_profiles_connector_key_nullable.sql.
    // Drops NOT NULL on auth_profiles.connector_key so browser_session profiles
    // (a device-bound resource) no longer require a per-connector binding.
    id: 'auth-profiles-connector-key-nullable',
    apply: async (sql) => {
      await sql.unsafe(`
        ALTER TABLE public.auth_profiles
        ALTER COLUMN connector_key DROP NOT NULL
      `);
      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'auth_profiles_connector_key_required'
          ) THEN
            ALTER TABLE public.auth_profiles
              ADD CONSTRAINT auth_profiles_connector_key_required
              CHECK (
                connector_key IS NOT NULL
                OR profile_kind = 'browser_session'
              );
          END IF;
        END $$;
      `);
    },
  },
];
