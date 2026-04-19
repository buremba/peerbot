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
import { existsSync, mkdirSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

dotenv.config();

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
const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const require = createRequire(import.meta.url);

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
  const { startMaintenanceScheduler } = await import('./scheduled/jobs');

  await initWorkspaceProvider();

  const env = getEnvFromProcess();
  const stopScheduler = startMaintenanceScheduler(env);

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

    const migrationsDir = join(REPO_ROOT, 'db', 'migrations');
    if (!existsSync(migrationsDir)) {
      throw new Error(`Migrations directory not found: ${migrationsDir}.`);
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
];

async function applyEmbeddedSchemaPatches(sql: MigrationSqlClient) {
  for (const patch of EMBEDDED_SCHEMA_PATCHES) {
    logger.info({ patch: patch.id }, 'Applying embedded schema patch');
    await patch.apply(sql);
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
  const serverPath = join(REPO_ROOT, 'packages', 'embeddings-service', 'src', 'server.ts');
  if (!existsSync(serverPath)) {
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
  logger.error({ error }, 'Failed to start');
  process.exit(1);
});
