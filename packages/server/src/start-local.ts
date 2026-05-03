/**
 * Local Server Entry Point (PGlite)
 *
 * Runs the full Owletto stack in a single command:
 * - PGlite (WASM Postgres with pgvector + pg_trgm) — in-process
 * - Hono HTTP server — in-process
 * - Embeddings service — child process on port 8790
 * - Maintenance scheduler — in-process
 *
 * Data stored at ~/.owletto/data/ (configurable via OWLETTO_DATA_DIR).
 */

import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

dotenv.config();

import { generatePAT, getPATPrefix, hashToken } from './auth/oauth/utils';

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite/vector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { listMigrationFiles, loadMigrationUpSection } from './db/migration-loader';
import type { Env } from './index';
import { getEnvFromProcess } from './utils/env';
import logger from './utils/logger';

const DATA_DIR = process.env.OWLETTO_DATA_DIR || join(homedir(), '.owletto', 'data');
const PORT = parseInt(process.env.PORT || '8787', 10);
const HOST = process.env.HOST?.trim() || '0.0.0.0';
const EMBEDDINGS_PORT = parseInt(process.env.EMBEDDINGS_PORT || '0', 10);
const APP_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(import.meta.url);

function resolveExistingPath(...candidates: Array<string | undefined>): string | null {
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isTruthyEnv(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name]?.trim() ?? '');
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });

  // Set all env vars FIRST — before any imports that might read them
  if (!process.env.BETTER_AUTH_SECRET) {
    process.env.BETTER_AUTH_SECRET = randomBytes(32).toString('base64');
    logger.info('Generated ephemeral BETTER_AUTH_SECRET — set in .env to persist sessions');
  }
  if (!process.env.JWT_SECRET) {
    process.env.JWT_SECRET = randomBytes(32).toString('base64');
  }
  if (!process.env.PUBLIC_WEB_URL) {
    process.env.PUBLIC_WEB_URL = `http://localhost:${PORT}`;
  }
  if (!process.env.NODE_ENV) {
    process.env.NODE_ENV = 'development';
  }
  process.env.PGSSLMODE = 'disable';
  process.env.OWLETTO_DISABLE_PREPARE = '1';

  // ─── PGlite ──────────────────────────────────────────────────

  logger.info({ dataDir: DATA_DIR }, 'Starting PGlite');
  const db = await PGlite.create({
    dataDir: DATA_DIR,
    extensions: { vector, pg_trgm },
  });

  // ─── PGlite Socket Server ────────────────────────────────────
  // Start socket FIRST, then run everything (including migrations)
  // through it. No direct PGlite access after this point.

  const pgSocketPort = parseInt(process.env.PG_SOCKET_PORT || '0', 10);
  const socketServer = new PGLiteSocketServer({
    db,
    port: pgSocketPort,
    maxConnections: readPositiveIntEnv('OWLETTO_PGLITE_SOCKET_MAX_CONNECTIONS', 64),
    idleTimeout: readPositiveIntEnv('OWLETTO_PGLITE_SOCKET_IDLE_TIMEOUT_MS', 0),
    debug: isTruthyEnv('OWLETTO_PGLITE_SOCKET_DEBUG'),
  });
  socketServer.addEventListener('error', (event: Event) => {
    logger.error({ error: (event as CustomEvent).detail }, 'PGlite socket server error');
  });
  socketServer.addEventListener('close', () => {
    logger.warn('PGlite socket server closed');
  });
  // Wait for listening event to get the actual port (especially when port=0)
  const actualPgPort = await new Promise<number>((resolve) => {
    socketServer.addEventListener('listening', (e: Event) => {
      resolve((e as CustomEvent).detail?.port ?? pgSocketPort);
    });
    socketServer.start();
  });
  // sslmode=disable is required — PGlite socket doesn't support SSL negotiation
  const dbUrl = `postgresql://postgres@127.0.0.1:${actualPgPort}/postgres?sslmode=disable`;
  process.env.DATABASE_URL = dbUrl;
  logger.info({ port: actualPgPort }, 'PGlite socket server ready');

  // Run migrations through the socket (not direct PGlite)
  await runMigrations(dbUrl);

  // ─── Embeddings Service (child process) ──────────────────────

  const embeddingsChild = await startEmbeddings();

  // ─── App Server ──────────────────────────────────────────────

  const { app: mainApp } = await import('./index');
  const { initWorkspaceProvider } = await import('./workspace');
  const { initLobuGateway, getLobuCoreServices } = await import('./lobu/gateway');
  const { bootTaskScheduler } = await import('./scheduled/jobs');

  await initWorkspaceProvider();
  await initLobuGateway();

  const env = getEnvFromProcess();
  const taskScheduler = await bootTaskScheduler(getLobuCoreServices(), env);
  const stopScheduler = () => taskScheduler.stop();

  const wrapper = new Hono<{ Bindings: Env }>();
  wrapper.use('*', async (c, next) => {
    Object.assign(c.env, env);
    return next();
  });
  wrapper.route('/', mainApp);

  const httpServer = http.createServer(getRequestListener(wrapper.fetch));

  // ─── Graceful Shutdown ───────────────────────────────────────

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    stopScheduler();
    httpServer.close();
    embeddingsChild?.kill();
    await socketServer.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // ─── Listen ──────────────────────────────────────────────────

  httpServer.listen(PORT, HOST, () => {
    logger.info(`Owletto running at http://${HOST}:${PORT}`);
    logger.info(`Data: ${DATA_DIR}`);
  });

  // ─── Bootstrap PAT ───────────────────────────────────────────
  // Self-skips when the deployment already has users (production safety) or
  // when a bootstrap PAT has already been minted under OWLETTO_DATA_DIR.
  // Replaces the previous LOBU_LOCAL_BOOTSTRAP env-flag gate — operators no
  // longer need to opt in for first-run local dev.
  try {
    await ensureBootstrapPat(dbUrl);
  } catch (err) {
    logger.warn({ err }, 'Bootstrap PAT setup failed');
  }
}

// ─── Migrations ──────────────────────────────────────────────────

async function runMigrations(dbUrl: string) {
  const pg = await import('postgres');
  const sql = pg.default(dbUrl, { max: 1 });

  try {
    const [{ cnt }] = await sql<[{ cnt: number }]>`
      SELECT count(*)::int AS cnt FROM pg_tables
      WHERE schemaname = 'public' AND tablename = 'organization'
    `;
    if (cnt > 0) {
      logger.info('Database already initialized; applying legacy embedded schema patches');
      await applyEmbeddedSchemaPatches(sql);
      return;
    }

    const migrationsDir = resolveExistingPath(
      join(APP_ROOT, 'db', 'migrations'),
      join(process.cwd(), 'db', 'migrations')
    );
    if (!migrationsDir) {
      throw new Error('Migrations directory not found.');
    }

    logger.info('Running migrations...');
    for (const file of listMigrationFiles(migrationsDir)) {
      const migrationSql = loadMigrationUpSection(migrationsDir, file);
      if (!migrationSql) continue;

      await sql.unsafe('SET search_path TO public');
      await sql.unsafe(migrationSql);
    }

    logger.info('Migrations complete');
  } finally {
    await sql.end();
  }
}

type MigrationSqlClient = {
  unsafe: (...args: any[]) => Promise<unknown>;
};

interface EmbeddedSchemaPatch {
  id: string;
  apply: (sql: MigrationSqlClient) => Promise<void>;
}

const EMBEDDED_SCHEMA_PATCHES: EmbeddedSchemaPatch[] = [
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
];

async function applyEmbeddedSchemaPatches(sql: MigrationSqlClient) {
  for (const patch of EMBEDDED_SCHEMA_PATCHES) {
    logger.info({ patch: patch.id }, 'Applying embedded schema patch');
    await patch.apply(sql);
  }
}

// ─── Bootstrap PAT ────────────────────────────────────────────────
//
// Mints a default user, personal org (slug `dev`), member, and PAT scoped to
// both. Self-skips when (a) `bootstrap-pat.txt` already exists under
// OWLETTO_DATA_DIR, or (b) the deployment already has users. The second guard
// prevents auto-bootstrap from polluting a production deployment that already
// has real users provisioned via the web UI.

const BOOTSTRAP_USER_ID = 'bootstrap-user';
const BOOTSTRAP_USER_EMAIL = 'dev@local';
const BOOTSTRAP_USER_NAME = 'Local Developer';
const BOOTSTRAP_USERNAME = 'dev-local';
const BOOTSTRAP_ORG_ID = 'org-bootstrap-dev';
const BOOTSTRAP_ORG_SLUG = 'dev';
const BOOTSTRAP_ORG_NAME = 'Local Dev';
const BOOTSTRAP_MEMBER_ID = 'member-bootstrap-dev';
const BOOTSTRAP_PAT_FILENAME = 'bootstrap-pat.txt';

function isLoopbackPgUrl(dbUrl: string): boolean {
  try {
    const { hostname } = new URL(dbUrl);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

async function ensureBootstrapPat(dbUrl: string): Promise<void> {
  // Defense-in-depth: this entrypoint spawns its own PGlite at 127.0.0.1
  // (see line 120 above). If the dbUrl ever points elsewhere — someone
  // refactors and reuses ensureBootstrapPat against a real DB — refuse
  // to mint. The user-count guard below is the second layer; this catches
  // the case where a fresh prod DB hasn't had its first signup yet.
  if (!isLoopbackPgUrl(dbUrl)) {
    logger.warn(
      { dbUrl: dbUrl.replace(/:[^:@/]*@/, ':***@') },
      'Skipping bootstrap PAT — dbUrl is not the local PGlite loopback'
    );
    return;
  }

  const patFilePath = join(DATA_DIR, BOOTSTRAP_PAT_FILENAME);
  if (existsSync(patFilePath)) {
    logger.info(
      { path: patFilePath, org: BOOTSTRAP_ORG_SLUG },
      'Bootstrap PAT already provisioned (delete the file to re-mint)'
    );
    return;
  }

  // Reuse the same dynamic-import shape `runMigrations` above uses so we share
  // postgres' module init cost with that path on first boot.
  const pg = await import('postgres');
  const sql = pg.default(dbUrl, { max: 1 });

  try {
    // Production safety: skip when users already exist. A deployment that has
    // real users provisioned via the web UI must not get a "Local Developer"
    // user grafted in alongside them.
    const userCountRows = await sql<[{ count: number }]>`
      SELECT count(*)::int AS count FROM "user"
    `;
    if ((userCountRows[0]?.count ?? 0) > 0) {
      logger.debug(
        { userCount: userCountRows[0]?.count },
        'Skipping bootstrap PAT — deployment already has users'
      );
      return;
    }

    // Idempotent user/org/member upsert. Re-runs of the embedded schema (e.g.
    // OWLETTO_DATA_DIR pre-existing without the PAT file) skip ON CONFLICT.
    await sql`
      INSERT INTO "user" (id, name, email, username, "emailVerified", "createdAt", "updatedAt")
      VALUES (
        ${BOOTSTRAP_USER_ID},
        ${BOOTSTRAP_USER_NAME},
        ${BOOTSTRAP_USER_EMAIL},
        ${BOOTSTRAP_USERNAME},
        true,
        NOW(),
        NOW()
      )
      ON CONFLICT (id) DO NOTHING
    `;

    const metadata = JSON.stringify({ personal_org_for_user_id: BOOTSTRAP_USER_ID });
    await sql`
      INSERT INTO "organization" (id, name, slug, visibility, metadata, "createdAt")
      VALUES (
        ${BOOTSTRAP_ORG_ID},
        ${BOOTSTRAP_ORG_NAME},
        ${BOOTSTRAP_ORG_SLUG},
        'private',
        ${metadata},
        NOW()
      )
      ON CONFLICT (id) DO NOTHING
    `;

    await sql`
      INSERT INTO "member" (id, "userId", "organizationId", role, "createdAt")
      VALUES (
        ${BOOTSTRAP_MEMBER_ID},
        ${BOOTSTRAP_USER_ID},
        ${BOOTSTRAP_ORG_ID},
        'owner',
        NOW()
      )
      ON CONFLICT (id) DO NOTHING
    `;

    // Mint the PAT. Reuse the auth utils so the hash + prefix shapes stay in
    // lock-step with PersonalAccessTokenService.create().
    const token = generatePAT();
    const tokenHash = hashToken(token);
    const tokenPrefix = getPATPrefix(token);

    // Owner-tier scopes so admin-only tools (manage_entity_schema, etc.) work.
    // The bootstrap user is the org owner — no separate consent step. This
    // path is only reached on a deployment with no users; first real signup
    // via the web UI takes precedence on every subsequent boot.
    const bootstrapScope = 'mcp:read mcp:write mcp:admin';
    await sql`
      INSERT INTO personal_access_tokens (
        token_hash, token_prefix, user_id, organization_id,
        name, description, scope, expires_at
      ) VALUES (
        ${tokenHash},
        ${tokenPrefix},
        ${BOOTSTRAP_USER_ID},
        ${BOOTSTRAP_ORG_ID},
        'bootstrap',
        'auto-minted on first boot of an empty deployment',
        ${bootstrapScope},
        NULL
      )
    `;

    writeFileSync(patFilePath, `${token}\n`, { mode: 0o600 });

    const url = `http://localhost:${PORT}`;
    // PAT printed once for dev bootstrap; do not redirect this log line through
    // any remote sink (Sentry, OTEL exporter, etc.). The bootstrap PAT carries
    // full mcp:admin scope — treat it like a password.
    process.stdout.write(`[bootstrap PAT] ${token}\n`);
    process.stdout.write(`[bootstrap PAT] org=${BOOTSTRAP_ORG_SLUG} url=${url}\n`);
    process.stdout.write(`[bootstrap PAT] saved to ${patFilePath}\n`);
    process.stdout.write(
      `[bootstrap PAT] WARNING: this PAT has full mcp:admin scope. Treat it like a password.\n`
    );
    logger.info(
      { path: patFilePath, org: BOOTSTRAP_ORG_SLUG, url },
      'Bootstrap PAT minted (printed once, mcp:admin scope)'
    );
  } finally {
    await sql.end();
  }
}

// ─── Embeddings (child process) ──────────────────────────────────

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function startEmbeddings(): Promise<ReturnType<typeof fork> | null> {
  const serverPath = resolveExistingPath(
    join(APP_ROOT, 'packages', 'embeddings', 'src', 'server.ts'),
    join(process.cwd(), 'packages', 'embeddings', 'src', 'server.ts')
  );
  if (!serverPath) {
    logger.warn('Embeddings service not found — embedding generation will not be available');
    return null;
  }

  const port = EMBEDDINGS_PORT || (await findFreePort());
  const tsxPackageJson = require.resolve('tsx/package.json');
  const tsxLoaderPath = join(dirname(tsxPackageJson), 'dist', 'loader.mjs');

  const child = fork(serverPath, [], {
    execArgv: ['--import', tsxLoaderPath],
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });

  process.env.EMBEDDINGS_SERVICE_URL = `http://127.0.0.1:${port}`;

  child.stdout?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) logger.info({ service: 'embeddings' }, msg);
  });

  child.stderr?.on('data', (data: Buffer) => {
    const msg = data.toString().trim();
    if (msg) logger.warn({ service: 'embeddings' }, msg);
  });

  child.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      logger.warn({ code }, 'Embeddings service exited');
    }
  });

  return child;
}

main().catch((error) => {
  logger.error({ err: error }, 'Failed to start');
  process.exit(1);
});
