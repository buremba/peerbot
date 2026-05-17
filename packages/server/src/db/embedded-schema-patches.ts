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

interface EmbeddedSchemaPatch {
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
      // Add the single-column FK only when `agents.id` still has a unique
      // constraint to reference. The later `agents-per-org-pk-phase-c` patch
      // swaps the PK to composite `(organization_id, id)` and installs
      // `scheduled_jobs_org_agent_fkey` in place of this one — after that
      // swap, re-adding the single-column FK fails with 42830 ("no unique
      // constraint matching given keys for referenced table"). Skip when the
      // composite FK is already present *or* when no single-column unique
      // exists on agents(id). Issue lobu#787.
      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (SELECT 1 FROM pg_class WHERE relname = 'agents' AND relkind = 'r') THEN
            RETURN;
          END IF;
          IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_jobs_agent_fkey') THEN
            RETURN;
          END IF;
          IF EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'scheduled_jobs_org_agent_fkey') THEN
            -- Composite FK already installed by the later phase-c patch.
            RETURN;
          END IF;
          -- Confirm a single-column unique/PK exists on agents(id) before
          -- referencing it; otherwise the ADD CONSTRAINT will crash with 42830.
          IF NOT EXISTS (
            SELECT 1
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
            WHERE n.nspname = 'public'
              AND t.relname = 'agents'
              AND c.contype IN ('p', 'u')
              AND array_length(c.conkey, 1) = 1
              AND a.attname = 'id'
          ) THEN
            RETURN;
          END IF;
          ALTER TABLE public.scheduled_jobs
            ADD CONSTRAINT scheduled_jobs_agent_fkey
            FOREIGN KEY (created_by_agent) REFERENCES public.agents(id) ON DELETE CASCADE;
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
  {
    // Mirrors db/migrations/20260515120000_agents_per_org_pk.sql — phase A only.
    // Adds organization_id (NULLABLE) to the 5 FK-holding child tables, backfills
    // from agents, adds a parallel UNIQUE (organization_id, id) on agents, and
    // creates composite indexes for upcoming org-scoped queries. The PK swap
    // and FK composite migration ship in a later phase once the storage
    // interfaces are plumbed with organization_id everywhere.
    id: 'agents-per-org-pk-phase-a',
    apply: async (sql) => {
      for (const t of [
        'agent_grants',
        'agent_connections',
        'agent_users',
        'agent_channel_bindings',
        'grants',
      ]) {
        await sql.unsafe(`
          ALTER TABLE public.${t}
          ADD COLUMN IF NOT EXISTS organization_id text
        `);
        await sql.unsafe(`
          UPDATE public.${t} c
          SET organization_id = a.organization_id
          FROM public.agents a
          WHERE c.agent_id = a.id AND c.organization_id IS NULL
        `);
        await sql.unsafe(`
          CREATE INDEX IF NOT EXISTS ${t}_org_agent_idx
          ON public.${t} (organization_id, agent_id)
        `);
      }
      // Note: an earlier revision of this patch added a parallel UNIQUE
      // (organization_id, id) on agents. It was reverted in
      // db/migrations/20260515160000_drop_agents_org_id_unique.sql because
      // it broke `ON CONFLICT (id) DO NOTHING/UPDATE` callers — Postgres
      // can violate the new constraint before reaching the PK conflict,
      // and ON CONFLICT (id) only suppresses the named constraint. The
      // PK on (id) already enforces global uniqueness. Phase C of the
      // per-org PK migration will swap the PK directly.
    },
  },
  {
    // Mirrors db/migrations/20260515160000_drop_agents_org_id_unique.sql.
    id: 'drop-agents-org-id-unique',
    apply: async (sql) => {
      await sql.unsafe(
        `ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_organization_id_id_key`
      );
    },
  },
  {
    // Mirrors db/migrations/20260516120000_agents_per_org_pk_swap.sql.
    // Detects whether the swap has already happened by reading the current
    // PK definition on `agents`; skips silently when the composite PK is
    // already in place.
    id: 'agents-per-org-pk-phase-c',
    apply: async (sql) => {
      const pkDef = (await sql.unsafe(`
        SELECT pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'public'
          AND t.relname = 'agents'
          AND c.contype = 'p'
        LIMIT 1
      `)) as Array<{ def: string }>;
      const def = pkDef[0]?.def ?? '';
      if (def.includes('organization_id') && def.includes('id')) {
        // Composite PK already in place — nothing to do.
        return;
      }

      // Backfill any stragglers and drop orphans.
      for (const t of [
        'agent_grants',
        'agent_connections',
        'agent_users',
        'agent_channel_bindings',
        'grants',
      ]) {
        await sql.unsafe(`
          UPDATE public.${t} c
          SET organization_id = a.organization_id
          FROM public.agents a
          WHERE c.organization_id IS NULL AND c.agent_id = a.id
        `);
        await sql.unsafe(`
          DELETE FROM public.${t} WHERE organization_id IS NULL
        `);
        await sql.unsafe(`
          ALTER TABLE public.${t} ALTER COLUMN organization_id SET NOT NULL
        `);
      }

      // Drop legacy single-column FKs.
      await sql.unsafe(
        `ALTER TABLE public.agent_grants           DROP CONSTRAINT IF EXISTS agent_grants_agent_id_fkey`
      );
      await sql.unsafe(
        `ALTER TABLE public.agent_connections      DROP CONSTRAINT IF EXISTS agent_connections_agent_id_fkey`
      );
      await sql.unsafe(
        `ALTER TABLE public.agent_users            DROP CONSTRAINT IF EXISTS agent_users_agent_id_fkey`
      );
      await sql.unsafe(
        `ALTER TABLE public.agent_channel_bindings DROP CONSTRAINT IF EXISTS agent_channel_bindings_agent_id_fkey`
      );
      await sql.unsafe(
        `ALTER TABLE public.grants                 DROP CONSTRAINT IF EXISTS grants_agent_id_fkey`
      );
      await sql.unsafe(
        `ALTER TABLE public.scheduled_jobs         DROP CONSTRAINT IF EXISTS scheduled_jobs_agent_fkey`
      );

      // Drop legacy uniques/PKs scoped to bare agent_id.
      await sql.unsafe(
        `ALTER TABLE public.agent_grants DROP CONSTRAINT IF EXISTS agent_grants_agent_id_pattern_key`
      );
      await sql.unsafe(
        `ALTER TABLE public.agent_users  DROP CONSTRAINT IF EXISTS agent_users_pkey`
      );
      await sql.unsafe(
        `ALTER TABLE public.grants       DROP CONSTRAINT IF EXISTS grants_pkey`
      );

      // Swap PK on agents.
      await sql.unsafe(`ALTER TABLE public.agents DROP CONSTRAINT IF EXISTS agents_pkey`);
      await sql.unsafe(
        `ALTER TABLE public.agents ADD CONSTRAINT agents_pkey PRIMARY KEY (organization_id, id)`
      );

      // Re-add per-org-scoped uniques.
      await sql.unsafe(`
        ALTER TABLE public.agent_grants
          ADD CONSTRAINT agent_grants_org_agent_pattern_key UNIQUE (organization_id, agent_id, pattern)
      `);
      await sql.unsafe(`
        ALTER TABLE public.agent_users
          ADD CONSTRAINT agent_users_pkey PRIMARY KEY (organization_id, agent_id, platform, user_id)
      `);
      await sql.unsafe(`
        ALTER TABLE public.grants
          ADD CONSTRAINT grants_pkey PRIMARY KEY (organization_id, agent_id, kind, pattern)
      `);

      // Re-add composite FKs into agents(organization_id, id).
      await sql.unsafe(`
        ALTER TABLE public.agent_grants
          ADD CONSTRAINT agent_grants_org_agent_fkey
          FOREIGN KEY (organization_id, agent_id) REFERENCES public.agents(organization_id, id) ON DELETE CASCADE
      `);
      await sql.unsafe(`
        ALTER TABLE public.agent_connections
          ADD CONSTRAINT agent_connections_org_agent_fkey
          FOREIGN KEY (organization_id, agent_id) REFERENCES public.agents(organization_id, id) ON DELETE CASCADE
      `);
      await sql.unsafe(`
        ALTER TABLE public.agent_users
          ADD CONSTRAINT agent_users_org_agent_fkey
          FOREIGN KEY (organization_id, agent_id) REFERENCES public.agents(organization_id, id) ON DELETE CASCADE
      `);
      await sql.unsafe(`
        ALTER TABLE public.agent_channel_bindings
          ADD CONSTRAINT agent_channel_bindings_org_agent_fkey
          FOREIGN KEY (organization_id, agent_id) REFERENCES public.agents(organization_id, id) ON DELETE CASCADE
      `);
      await sql.unsafe(`
        ALTER TABLE public.grants
          ADD CONSTRAINT grants_org_agent_fkey
          FOREIGN KEY (organization_id, agent_id) REFERENCES public.agents(organization_id, id) ON DELETE CASCADE
      `);
      await sql.unsafe(`
        ALTER TABLE public.scheduled_jobs
          ADD CONSTRAINT scheduled_jobs_org_agent_fkey
          FOREIGN KEY (organization_id, created_by_agent) REFERENCES public.agents(organization_id, id) ON DELETE CASCADE
      `);
    },
  },
  {
    // Mirrors db/migrations/20260517060000_watcher_schema_additions.sql.
    // Adds dispatcher-related columns to watchers (device_worker_id,
    // agent_kind, notification_channel, notification_priority,
    // min_cooldown_seconds, last_fired_at) plus the per-device daily
    // notification budget on device_workers. Idempotent for replay on
    // already-initialised embedded/PGlite databases — each ADD COLUMN is
    // wrapped in a duplicate_column-tolerant DO block; constraint and index
    // creation is gated on pg_constraint / IF NOT EXISTS.
    id: 'watcher-schema-additions',
    apply: async (sql) => {
      const watcherColumns: Array<{ name: string; ddl: string }> = [
        {
          name: 'device_worker_id',
          ddl: `ALTER TABLE public.watchers
                  ADD COLUMN device_worker_id uuid REFERENCES public.device_workers(id)`,
        },
        {
          name: 'agent_kind',
          ddl: `ALTER TABLE public.watchers ADD COLUMN agent_kind text`,
        },
        {
          name: 'notification_channel',
          ddl: `ALTER TABLE public.watchers
                  ADD COLUMN notification_channel text NOT NULL DEFAULT 'canvas'`,
        },
        {
          name: 'notification_priority',
          ddl: `ALTER TABLE public.watchers
                  ADD COLUMN notification_priority text NOT NULL DEFAULT 'normal'`,
        },
        {
          name: 'min_cooldown_seconds',
          ddl: `ALTER TABLE public.watchers
                  ADD COLUMN min_cooldown_seconds integer NOT NULL DEFAULT 0`,
        },
        {
          name: 'last_fired_at',
          ddl: `ALTER TABLE public.watchers
                  ADD COLUMN last_fired_at timestamp with time zone`,
        },
      ];
      for (const col of watcherColumns) {
        await sql.unsafe(`
          DO $$
          BEGIN
            ${col.ddl};
          EXCEPTION WHEN duplicate_column THEN NULL;
          END $$;
        `);
      }

      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'watchers_notification_channel_check'
          ) THEN
            ALTER TABLE public.watchers
              ADD CONSTRAINT watchers_notification_channel_check
              CHECK (notification_channel IN ('canvas', 'notification', 'both'));
          END IF;
        END $$;
      `);
      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'watchers_notification_priority_check'
          ) THEN
            ALTER TABLE public.watchers
              ADD CONSTRAINT watchers_notification_priority_check
              CHECK (notification_priority IN ('low', 'normal', 'high'));
          END IF;
        END $$;
      `);
      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'watchers_min_cooldown_seconds_nonneg'
          ) THEN
            ALTER TABLE public.watchers
              ADD CONSTRAINT watchers_min_cooldown_seconds_nonneg
              CHECK (min_cooldown_seconds >= 0);
          END IF;
        END $$;
      `);

      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_watchers_device_worker_id
          ON public.watchers (device_worker_id)
          WHERE device_worker_id IS NOT NULL
      `);

      await sql.unsafe(`
        DO $$
        BEGIN
          ALTER TABLE public.device_workers
            ADD COLUMN notification_budget_per_day integer NOT NULL DEFAULT 10;
        EXCEPTION WHEN duplicate_column THEN NULL;
        END $$;
      `);
      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conname = 'device_workers_notification_budget_per_day_nonneg'
          ) THEN
            ALTER TABLE public.device_workers
              ADD CONSTRAINT device_workers_notification_budget_per_day_nonneg
              CHECK (notification_budget_per_day >= 0);
          END IF;
        END $$;
      `);
    },
  },
  {
    // Mirrors db/migrations/20260517150000_goals_primitive.sql.
    //
    // Creates the `goals` table (top-level handle that groups watchers under
    // a single user intent) and adds `watchers.goal_id` as a nullable FK
    // with ON DELETE SET NULL. Idempotent — all DDL uses IF NOT EXISTS, and
    // the watcher column is only added when missing.
    //
    // Sequenced after `watcher-schema-additions` (#799); the only watcher-side
    // change here is the new column, which composes cleanly with the columns
    // added by that patch.
    id: 'goals-primitive',
    apply: async (sql) => {
      await sql.unsafe(`
        CREATE TABLE IF NOT EXISTS public.goals (
          id              bigserial PRIMARY KEY,
          organization_id text NOT NULL REFERENCES public.organization(id) ON DELETE CASCADE,
          slug            text NOT NULL,
          name            text NOT NULL,
          description     text,
          status          text NOT NULL DEFAULT 'active',
          template_key    text,
          metadata        jsonb NOT NULL DEFAULT '{}'::jsonb,
          created_at      timestamp with time zone NOT NULL DEFAULT now(),
          updated_at      timestamp with time zone NOT NULL DEFAULT now()
        )
      `);
      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'goals_status_check'
          ) THEN
            ALTER TABLE public.goals
              ADD CONSTRAINT goals_status_check
              CHECK (status IN ('active', 'paused', 'archived'));
          END IF;
        END$$;
      `);
      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'goals_org_slug_unique'
          ) THEN
            ALTER TABLE public.goals
              ADD CONSTRAINT goals_org_slug_unique UNIQUE (organization_id, slug);
          END IF;
        END$$;
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_goals_organization_id
          ON public.goals (organization_id)
      `);

      await sql.unsafe(`
        ALTER TABLE public.watchers
          ADD COLUMN IF NOT EXISTS goal_id bigint
      `);
      await sql.unsafe(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'watchers_goal_id_fkey'
          ) THEN
            ALTER TABLE public.watchers
              ADD CONSTRAINT watchers_goal_id_fkey
              FOREIGN KEY (goal_id) REFERENCES public.goals(id) ON DELETE SET NULL;
          END IF;
        END$$;
      `);
      await sql.unsafe(`
        CREATE INDEX IF NOT EXISTS idx_watchers_goal_id
          ON public.watchers (goal_id)
          WHERE goal_id IS NOT NULL
      `);
    },
  },
];
