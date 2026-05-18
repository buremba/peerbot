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

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite/vector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import {
  EMBEDDED_SCHEMA_PATCHES,
  type MigrationSqlClient,
} from './db/embedded-schema-patches';
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
  await initLobuGateway();

  const env = getEnvFromProcess();
  const taskScheduler = await bootTaskScheduler(getLobuCoreServices(), env);
  const stopScheduler = () => taskScheduler.stop();

  // 30s connector-run heartbeat-lost reaper (see check-stalled-executions.ts).
  // Same module used by the production server entrypoint; advisory lock makes
  // it safe to also have the 5min TaskScheduler cron firing the same sweep.
  const { startStaleRunReaper } = await import('./scheduled/check-stalled-executions');
  const stopReaper = startStaleRunReaper();

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

  // ─── Bootstrap user ──────────────────────────────────────────
  // Runs BEFORE listen so that the bootstrap user / org / member rows are
  // guaranteed to exist before the first request lands — first-boot UI
  // calls would otherwise race the seed and 401 against a not-yet-
  // provisioned user. Auth credentials (Better Auth sessions) are minted
  // on demand by `POST /api/local-init` once the listener is up.
  try {
    await ensureBootstrapUser(dbUrl);
  } catch (err) {
    logger.warn({ err }, 'Bootstrap user seed failed');
  }

  // ─── Default agent (Mac-app onboarding) ──────────────────────
  // Auto-provision the Owletto Personal agent for the bootstrap org
  // the first time the deployment boots. Sticky against deletion via a
  // sentinel in `organization.metadata` — if the user removes the agent
  // through the web UI we do NOT recreate it on the next boot.
  //
  // Best-effort: failure here does not block boot. The Mac app degrades to
  // an empty-agents state instead of failing to start the server.
  try {
    await ensureDefaultAgent(BOOTSTRAP_ORG_ID);
  } catch (err) {
    logger.warn({ err }, 'Default-agent provisioning failed');
  }

  // ─── Listen ──────────────────────────────────────────────────

  httpServer.listen(PORT, HOST, () => {
    logger.info(`Lobu running at http://${HOST}:${PORT}`);
    logger.info(`Data: ${DATA_DIR}`);
  });
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

async function applyEmbeddedSchemaPatches(sql: MigrationSqlClient) {
  // Embedded patches mirror DDL from `db/migrations/*.sql`. When a patch
  // actually changes the schema (column count delta), that's a drift signal:
  // the canonical migration didn't run for this database, either because a
  // dev edited an already-applied migration (the #639 footgun) or because
  // dbmate isn't wired up. Surface that loudly so it doesn't silently mask
  // the same bug class in dev that would crash in prod.
  async function schemaSnapshot(): Promise<{ columns: number; indexes: number }> {
    try {
      const rows = (await sql.unsafe(`
        SELECT
          (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public')::int AS columns,
          (SELECT count(*) FROM pg_indexes WHERE schemaname = 'public')::int AS indexes
      `)) as Array<{ columns: number; indexes: number }>;
      return rows[0] ?? { columns: 0, indexes: 0 };
    } catch {
      return { columns: 0, indexes: 0 };
    }
  }

  for (const patch of EMBEDDED_SCHEMA_PATCHES) {
    logger.info({ patch: patch.id }, 'Applying embedded schema patch');
    const before = await schemaSnapshot();
    await patch.apply(sql);
    const after = await schemaSnapshot();
    if (after.columns !== before.columns || after.indexes !== before.indexes) {
      logger.warn(
        {
          patch: patch.id,
          columnDelta: after.columns - before.columns,
          indexDelta: after.indexes - before.indexes,
        },
        'Embedded patch modified schema — the matching db/migrations/*.sql ' +
          'did not run for this database. If you just edited a migration, ' +
          'roll it back and ship a new dated migration file instead.'
      );
    }
  }
}

// ─── Bootstrap user ────────────────────────────────────────────────
//
// Seeds a default user, personal org (slug `dev`), member, and credential
// account so the embedded PGlite deployment has a signed-in identity from
// first boot. Self-skips when the user/org/member trio is already present
// or when the deployment has non-bootstrap users (production safety —
// real signups land via the web UI and own all subsequent boots).
//
// The auth credential itself (a Better Auth session token) is minted on
// demand via `POST /api/local-init` once the HTTP listener is up —
// CLI clients and the macOS menu bar both hit that endpoint instead of
// reading a long-lived token from disk. PostgreSQL holds the truth: the
// `session` table on issuance, the `user` row here on seeding.

const BOOTSTRAP_USER_ID = 'bootstrap-user';
// Needs a dotted domain — better-auth's email validator rejects bare `dev@local`.
const BOOTSTRAP_USER_EMAIL = 'dev@lobu.local';
const BOOTSTRAP_USER_NAME = 'Local Developer';
const BOOTSTRAP_USERNAME = 'dev-local';
const BOOTSTRAP_ORG_ID = 'org-bootstrap-dev';
const BOOTSTRAP_ORG_SLUG = 'dev';
const BOOTSTRAP_ORG_NAME = 'Local Dev';
const BOOTSTRAP_MEMBER_ID = 'member-bootstrap-dev';
// Fixed credential-login password for the bootstrap user. Local PGlite only —
// the user-count guard below means this never lands in a real deployment.
// Must be >= 8 chars to satisfy the web login form's minlength validation.
const BOOTSTRAP_PASSWORD = 'lobudev123';
const BOOTSTRAP_ACCOUNT_ID = 'account-bootstrap-dev';

function isLoopbackPgUrl(dbUrl: string): boolean {
  try {
    const { hostname } = new URL(dbUrl);
    return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1';
  } catch {
    return false;
  }
}

async function ensureBootstrapUser(dbUrl: string): Promise<void> {
  // Defense-in-depth: this entrypoint spawns its own PGlite at 127.0.0.1
  // (see line 120 above). If the dbUrl ever points elsewhere — someone
  // refactors and reuses ensureBootstrapUser against a real DB — refuse
  // to seed. The user-count guard below is the second layer; this catches
  // the case where a fresh prod DB hasn't had its first signup yet.
  if (!isLoopbackPgUrl(dbUrl)) {
    logger.warn(
      { dbUrl: dbUrl.replace(/:[^:@/]*@/, ':***@') },
      'Skipping bootstrap user seed — dbUrl is not the local PGlite loopback'
    );
    return;
  }

  // Reuse the same dynamic-import shape `runMigrations` above uses so we share
  // postgres' module init cost with that path on first boot.
  const pg = await import('postgres');
  const sql = pg.default(dbUrl, { max: 1 });

  try {
    // Stale-state detection: previously this early-returned whenever a PAT
    // file existed on disk, but a wiped LOBU_DATA_DIR could leave rows
    // missing. Check all three rows (user + org + member) — if ANY is
    // missing, re-seed to restore consistency.
    const stateRows = await sql<
      [{ user_exists: boolean; org_exists: boolean; member_exists: boolean }]
    >`
      SELECT
        EXISTS(SELECT 1 FROM "user"         WHERE id = ${BOOTSTRAP_USER_ID})   AS user_exists,
        EXISTS(SELECT 1 FROM "organization" WHERE id = ${BOOTSTRAP_ORG_ID})    AS org_exists,
        EXISTS(SELECT 1 FROM "member"       WHERE id = ${BOOTSTRAP_MEMBER_ID}) AS member_exists
    `;
    const allPresent =
      stateRows[0]?.user_exists && stateRows[0]?.org_exists && stateRows[0]?.member_exists;
    if (allPresent) {
      logger.info(
        { org: BOOTSTRAP_ORG_SLUG },
        'Bootstrap user + org + member already provisioned'
      );
      return;
    }
    if (stateRows[0]?.user_exists || stateRows[0]?.org_exists || stateRows[0]?.member_exists) {
      logger.warn(
        stateRows[0],
        'Bootstrap state is partial — re-seeding to restore consistency'
      );
    }

    // Production safety: skip when OTHER users exist. A deployment that has
    // real users provisioned via the web UI must not get a "Local Developer"
    // user grafted in alongside them. (The bootstrap-user check above doesn't
    // catch this — those other-user rows have different ids.)
    const otherUserCountRows = await sql<[{ count: number }]>`
      SELECT count(*)::int AS count FROM "user" WHERE id <> ${BOOTSTRAP_USER_ID}
    `;
    if ((otherUserCountRows[0]?.count ?? 0) > 0) {
      logger.debug(
        { userCount: otherUserCountRows[0]?.count },
        'Skipping bootstrap user seed — deployment already has non-bootstrap users'
      );
      return;
    }

    // Idempotent user/org/member upsert. Re-runs of the embedded schema (e.g.
    // LOBU_DATA_DIR pre-existing without the PAT file) skip ON CONFLICT.
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

    // Credential login for the web UI — same user, fixed password. Uses
    // better-auth's default password hasher so `/api/auth/sign-in/email`
    // accepts it. `emailVerified` was set true above, so no verification gate.
    const { hashPassword } = await import('better-auth/crypto');
    const passwordHash = await hashPassword(BOOTSTRAP_PASSWORD);
    await sql`
      INSERT INTO "account" (id, "accountId", "providerId", "userId", password, "createdAt", "updatedAt")
      VALUES (
        ${BOOTSTRAP_ACCOUNT_ID},
        ${BOOTSTRAP_USER_ID},
        'credential',
        ${BOOTSTRAP_USER_ID},
        ${passwordHash},
        NOW(),
        NOW()
      )
      ON CONFLICT ("providerId", "accountId") DO NOTHING
    `;

    const url = `http://localhost:${PORT}`;
    process.stdout.write(
      `[bootstrap login] ${BOOTSTRAP_USER_EMAIL} / ${BOOTSTRAP_PASSWORD}  →  ${url}\n`
    );
    logger.info(
      { org: BOOTSTRAP_ORG_SLUG, url },
      'Bootstrap user + web credential login seeded'
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
