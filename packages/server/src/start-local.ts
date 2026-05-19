/**
 * Local Server Entry Point (PGlite)
 *
 * Runs the full Lobu stack in a single command:
 * - PGlite (WASM Postgres with pgvector + pg_trgm) — in-process
 * - Hono HTTP server — in-process
 * - Embeddings service — child process on port 8790
 * - Maintenance scheduler — in-process
 *
 * Data stored at ~/.lobu/data/ (configurable via LOBU_DATA_DIR).
 */

// Refuse to boot under an unsupported Node major (isolated-vm gate). Module
// asserts on load, so this must be the first import; see assert-node-version.ts.
import './utils/assert-node-version';

import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

dotenv.config();

import { applyUserServerConfigToEnv } from './utils/user-config';

// After dotenv (project .env) so .env wins; before the module-level DATA_DIR
// / PORT / HOST reads below so user-config overrides from
// ~/.config/lobu/config.json land in time.
//
// DATABASE_URL is also filled in, but this bundle always boots PGlite and
// overwrites it (line ~141). External-Postgres routing happens upstream in
// `lobu run` (packages/cli/src/commands/dev.ts), which switches bundles when
// the user config or env pins DATABASE_URL. So in practice only LOBU_DATA_DIR
// / PORT / HOST flow through this call.
applyUserServerConfigToEnv();

import { ensureDefaultAgent } from './auth/default-provisioning';
import { ensureInstallOperator } from './auth/install-operator';

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

const DATA_DIR = process.env.LOBU_DATA_DIR || join(homedir(), '.lobu', 'data');
const PORT = parseInt(process.env.PORT || '8787', 10);
// Loopback-only by default: the embedded local-runner ships a
// loopback-trust endpoint (`POST /api/local-init`) that mints worker-scoped
// PATs for the bootstrap user with no auth challenge. Binding to 0.0.0.0
// would expose that to anyone on the LAN. Operators who explicitly want
// LAN/WAN reachability must set `HOST=0.0.0.0` themselves.
const HOST = process.env.HOST?.trim() || '127.0.0.1';
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
  process.env.LOBU_DISABLE_PREPARE = '1';
  // Single-user mode default: the embedded runner spawns its own PGlite,
  // seeds a single bootstrap user, and is expected to be used by exactly
  // one operator on one machine. Block additional sign-ups so the
  // operator can't accidentally fork into a second account (one for the
  // Mac app + CLI, one for the web UI) by visiting /sign-up. Operators
  // who actually want multi-user mode set LOBU_SINGLE_USER=0 explicitly.
  if (process.env.LOBU_SINGLE_USER === undefined) {
    process.env.LOBU_SINGLE_USER = '1';
  }

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
    maxConnections: readPositiveIntEnv('LOBU_PGLITE_SOCKET_MAX_CONNECTIONS', 64),
    idleTimeout: readPositiveIntEnv('LOBU_PGLITE_SOCKET_IDLE_TIMEOUT_MS', 0),
    debug: isTruthyEnv('LOBU_PGLITE_SOCKET_DEBUG'),
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
  const lobuApp = await initLobuGateway();

  const env = getEnvFromProcess();
  const taskScheduler = await bootTaskScheduler(getLobuCoreServices(), env);
  const stopScheduler = () => taskScheduler.stop();

  // 30s connector-run heartbeat-lost reaper (see check-stalled-executions.ts).
  // Same module used by the production server entrypoint; advisory lock makes
  // it safe to also have the 5min TaskScheduler cron firing the same sweep.
  const { startStaleRunReaper } = await import('./scheduled/check-stalled-executions');
  const stopReaper = startStaleRunReaper();

  // Embedded connector-worker daemon — same process executes
  // `runs(run_type='sync')` by polling our own `/api/workers/poll`.
  // Started AFTER `listen()` so the daemon's boot-time health check
  // can resolve. Opt-out: `LOBU_DISABLE_EMBEDDED_WORKER=1`.
  const { startEmbeddedConnectorWorker } = await import(
    './scheduled/embedded-connector-worker'
  );
  let embeddedWorker: ReturnType<typeof startEmbeddedConnectorWorker> = null;

  const wrapper = new Hono<{ Bindings: Env }>();
  wrapper.use('*', async (c, next) => {
    // Stash the peer TCP remote-address so handlers that need to enforce
    // a loopback-peer trust boundary (e.g. `/api/local-init`) can read it
    // from c.var. `Object.assign(c.env, env)` below preserves
    // `c.env.incoming` (the IncomingMessage Hono's Node adapter set), so
    // we read from there — same path `getConnInfo` uses.
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming;
    const peerRemoteAddress = incoming?.socket?.remoteAddress ?? null;
    if (peerRemoteAddress) c.set('peerRemoteAddress', peerRemoteAddress);
    Object.assign(c.env, env);
    return next();
  });
  // Mount the embedded Lobu gateway under /lobu (mirrors server.ts:199-202).
  // Without this, the public Agent API (`/lobu/api/v1/agents/*`) and bundled
  // docs are 404 in PGlite mode — only the org-scoped REST app at `/` works.
  // This was the missing piece behind PR #637, which only fixed the Postgres
  // entrypoint.
  if (lobuApp) {
    wrapper.route('/lobu', lobuApp);
  }
  wrapper.route('/', mainApp);

  const honoListener = getRequestListener(wrapper.fetch);
  const httpServer = http.createServer();
  // SSE streams (MCP) must survive idle periods — Node defaults to 5s.
  httpServer.keepAliveTimeout = 75_000;
  httpServer.headersTimeout = 76_000;

  // In development, serve the SPA with Vite HMR (middleware mode); otherwise
  // Hono handles every request directly. Dynamically imported so this entry
  // keeps its lazy-load discipline (assert-node-version / instrument first).
  const { mountViteDev } = await import('./dev-vite');
  const vite = await mountViteDev(httpServer, honoListener);
  if (!vite) {
    httpServer.on('request', honoListener);
  }

  // ─── Graceful Shutdown ───────────────────────────────────────

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutting down');
    if (embeddedWorker) {
      embeddedWorker.stop();
      // Best-effort drain; don't block shutdown forever on a stuck connector.
      await embeddedWorker.wait(15_000);
    }
    stopReaper();
    stopScheduler();
    await vite?.close();
    httpServer.close();
    embeddingsChild?.kill();
    await socketServer.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // ─── Install operator ────────────────────────────────────────
  // Runs BEFORE listen so headless installs (CI, containers, /tmp scaffolds
  // without a browser) can sign in via better-auth without a chicken-and-egg
  // /sign-up step. Provisions a synthetic `install_operator` user whose
  // password is the install's ENCRYPTION_KEY. Idempotent — re-running on a
  // boot where the operator already exists is a no-op. See
  // `docs/install-operator-bootstrap.md`.
  //
  // Carve-outs in auth/index.tsx + auth/config.ts exclude this row from
  // every human-discovery surface (signup count, member list, password
  // reset, magic link, OAuth account-linking) so the operator never
  // collides with real human users.
  try {
    await ensureInstallOperator();
  } catch (err) {
    logger.error({ err }, 'Install-operator provisioning failed');
    // Don't crash the server — the operator only matters for headless
    // installs; a browser-based signup still works. But log it loudly.
  }

  // ─── Default agent (Mac-app onboarding) ──────────────────────
  // Default-agent provisioning is deferred to first-user creation. The
  // `databaseHooks.user.create.after` hook in auth/index.tsx provisions the
  // personal org; ensureDefaultAgent runs the next time `lobu run` boots
  // after the user exists.
  try {
    const personalOrgRows = (await import('postgres')).default(dbUrl, { max: 1 });
    try {
      const rows =
        (await personalOrgRows`SELECT id FROM "organization" WHERE (metadata::jsonb)->>'personal_org_for_user_id' IS NOT NULL ORDER BY "createdAt" ASC LIMIT 1`) as unknown as Array<{ id: string }>;
      const orgId = rows[0]?.id;
      if (orgId) await ensureDefaultAgent(orgId);
    } finally {
      await personalOrgRows.end({ timeout: 1 });
    }
  } catch (err) {
    logger.warn({ err }, 'Default-agent provisioning failed');
  }

  // ─── Listen ──────────────────────────────────────────────────

  httpServer.listen(PORT, HOST, () => {
    logger.info(`Lobu running at http://${HOST}:${PORT}`);
    logger.info(`Data: ${DATA_DIR}`);
    // Embedded daemon must wait for the listener — its boot-time
    // health check hits `/api/health` on this same process.
    embeddedWorker = startEmbeddedConnectorWorker(env, `http://${HOST}:${PORT}`);
  });
}

// ─── Migrations ──────────────────────────────────────────────────

async function runMigrations(dbUrl: string) {
  // Embedded boot runs the same migrations dbmate uses for prod, applied
  // unconditionally. After the schema squash (2026-05-19), the migrations
  // dir is a single baseline + any forward deltas; both are idempotent
  // enough to replay on a pre-initialized DB:
  //   - The baseline starts with `CREATE TABLE` against a fresh schema
  //     and is gated by a `schema_migrations` row insertion. On a DB that
  //     has the baseline applied, dbmate-style version tracking skips the
  //     file; we do the same below.
  //   - Forward deltas use `IF NOT EXISTS` discipline so re-application
  //     against an already-migrated DB is a no-op.
  const pg = await import('postgres');
  const sql = pg.default(dbUrl, { max: 1 });

  try {
    const migrationsDir = resolveExistingPath(
      // Published @lobu/cli copies migrations next to start-local.bundle.mjs
      // under dist/db/migrations.
      join(fileURLToPath(new URL('.', import.meta.url)), 'db', 'migrations'),
      join(APP_ROOT, 'db', 'migrations'),
      // Monorepo `bun run --filter @lobu/server dev:local`: APP_ROOT is
      // packages/server/, so the migrations live two levels up at repo root.
      join(APP_ROOT, '..', '..', 'db', 'migrations'),
      join(process.cwd(), 'db', 'migrations'),
      join(process.cwd(), '..', '..', 'db', 'migrations')
    );
    if (!migrationsDir) {
      throw new Error('Migrations directory not found.');
    }

    // Make sure the `schema_migrations` ledger exists before we read it.
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS public.schema_migrations (
        version character varying(128) NOT NULL PRIMARY KEY
      )
    `);

    const appliedRows = (await sql.unsafe(
      `SELECT version FROM public.schema_migrations`
    )) as Array<{ version: string }>;
    const applied = new Set(appliedRows.map((r) => r.version));

    // Versions whose contents are known to be fully covered by an existing
    // schema (i.e. the squashed baseline). When one of these errors with a
    // duplicate-object SQLSTATE the DB is already at the target state and we
    // can safely record the version as applied. This is intentionally narrow:
    // any future delta migration must use `IF NOT EXISTS` discipline rather
    // than relying on this fallback, or its mid-file failures could mask
    // schema drift.
    const IDEMPOTENT_BASELINE_VERSIONS = new Set(['00000000000000']);

    logger.info('Running migrations...');
    for (const file of listMigrationFiles(migrationsDir)) {
      // Filename convention is `<version>_<slug>.sql`; the version is the
      // leading underscore-separated prefix.
      const version = file.split('_')[0] ?? '';
      if (applied.has(version)) {
        continue;
      }
      const migrationSql = loadMigrationUpSection(migrationsDir, file);
      if (!migrationSql) continue;

      await sql.unsafe('SET search_path TO public');
      try {
        await sql.unsafe(migrationSql);
      } catch (err) {
        // The squashed baseline uses plain `CREATE FUNCTION` / `CREATE TABLE`
        // for cleanliness, so replaying it against a DB that already has the
        // schema raises `42723` (duplicate function) / `42P07` (duplicate
        // table) / `42710` (duplicate object). When the failing file is the
        // baseline, that's exactly the no-op case `lobu run` should treat as
        // success. For any other migration the duplicate error is surfaced
        // unchanged so partial failures cannot silently advance the ledger
        // (see `IDEMPOTENT_BASELINE_VERSIONS` above).
        const code = (err as { code?: string } | null)?.code;
        const isDuplicateObject =
          code === '42723' || code === '42P07' || code === '42710';
        if (!isDuplicateObject || !IDEMPOTENT_BASELINE_VERSIONS.has(version)) {
          throw err;
        }
        logger.info(
          { migration: file, version, pgErrorCode: code },
          'Migration already applied (idempotent skip)'
        );
      }
      await sql`
        INSERT INTO public.schema_migrations (version) VALUES (${version})
        ON CONFLICT DO NOTHING
      `;
    }

    logger.info('Migrations complete');
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
  const publishedServerPath = (() => {
    try {
      return fileURLToPath(import.meta.resolve('@lobu/embeddings/server'));
    } catch {
      return null;
    }
  })();
  const serverPath = resolveExistingPath(
    join(APP_ROOT, 'packages', 'embeddings', 'src', 'server.ts'),
    join(process.cwd(), 'packages', 'embeddings', 'src', 'server.ts'),
    ...(publishedServerPath ? [publishedServerPath] : [])
  );
  if (!serverPath) {
    logger.warn('Embeddings service not found — embedding generation will not be available');
    return null;
  }

  const port = EMBEDDINGS_PORT || (await findFreePort());
  const isTypescriptServer = serverPath.endsWith('.ts');
  let execArgv: string[] = [];
  if (isTypescriptServer) {
    const tsxPackageJson = require.resolve('tsx/package.json');
    const tsxLoaderPath = join(dirname(tsxPackageJson), 'dist', 'loader.mjs');
    execArgv = ['--import', tsxLoaderPath];
  }

  const child = fork(serverPath, [], {
    execArgv,
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
