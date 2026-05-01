/**
 * Node.js Server Entry Point
 *
 * This file starts the Hono server with @hono/node-server and sets up:
 * - HTTP server with environment injection
 * - Vite dev server in development (middleware mode, same port)
 * - Scheduled maintenance tasks
 * - Sentry error tracking
 */

// Sentry must init before any other imports for auto-instrumentation
import './instrument';

import dotenv from 'dotenv';

dotenv.config();

import { existsSync } from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import type { Env } from './index';
import { app as mainApp, setViteDev } from './index';
import { assertExternalDepsResolvable } from '../../connector-worker/src/runtime-deps';
import { getEnvFromProcess } from './utils/env';
import logger from './utils/logger';
import { initWorkspaceProvider } from './workspace';

// Crash loud at boot if the runtime image is missing any connector external
// dep, instead of letting every feed silently fail with "Missing npm
// dependency: X" hours later.
assertExternalDepsResolvable(createRequire(import.meta.url).resolve);

// Create a wrapper app that injects environment into each request
const app = new Hono<{ Bindings: Env }>();

// Resolve repo root from this source file: …/packages/server/src/server.ts → repo root.
const PACKAGE_REPO_ROOT = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..'
);

// Make LOBU_DEV_PROJECT_PATH defaultable when invoked from the package dir
// (`cd packages/server && bun run dev`). Downstream consumers like
// the embedded gateway's buildGatewayConfig() read this to derive worker
// paths; without this fallback they'd resolve against process.cwd().
if (!process.env.LOBU_DEV_PROJECT_PATH) {
  process.env.LOBU_DEV_PROJECT_PATH = PACKAGE_REPO_ROOT;
}

function resolveWebSourceRoot(): string {
  const explicit = process.env.WEB_SOURCE_DIR?.trim();
  if (explicit) {
    if (!existsSync(path.join(explicit, 'index.html'))) {
      throw new Error(
        `WEB_SOURCE_DIR set but no index.html found: ${explicit}`
      );
    }
    return explicit;
  }

  const projectRoot =
    process.env.LOBU_DEV_PROJECT_PATH || PACKAGE_REPO_ROOT;
  const webSourceDir = path.resolve(
    projectRoot,
    'packages/web'
  );
  if (!existsSync(path.join(webSourceDir, 'index.html'))) {
    throw new Error(
      `Owletto web source directory not found: ${webSourceDir}. ` +
        `Set WEB_SOURCE_DIR or LOBU_DEV_PROJECT_PATH to the monorepo root.`
    );
  }
  return webSourceDir;
}

// Inject environment variables into Hono context
const env = getEnvFromProcess();
app.use('*', async (c, next) => {
  // Set environment variables on the context
  Object.assign(c.env, env);
  return next();
});

/**
 * Main server startup
 */
async function main() {
  const databaseUrl = process.env.DATABASE_URL?.trim();
  if (!databaseUrl) {
    throw new Error(
      'DATABASE_URL is required. Use a PostgreSQL connection string (for local dev run: pnpm dev:all).'
    );
  }
  process.env.DATABASE_URL = databaseUrl;

  // Verify LISTEN/NOTIFY actually delivers. This is a *detector*, not a gate:
  // the runs-queue has a 200ms SKIP-LOCKED poll fallback that keeps the queue
  // correct even when LISTEN is silently dropped (transaction-mode pgbouncer,
  // RDS Proxy, etc.). Failing the probe just means wakeup latency degrades to
  // the poll interval — not an outage. Log loudly so ops can fix the pooler
  // config, but do not refuse to boot.
  if (process.env.SKIP_LISTEN_NOTIFY_PROBE !== '1') {
    const { probeListenNotify } = await import('./db/client');
    try {
      await probeListenNotify();
      logger.info('[DB] LISTEN/NOTIFY probe ok');
    } catch (err) {
      logger.warn(
        { err },
        '[DB] LISTEN/NOTIFY probe failed — runs-queue will fall back to 200ms poll. Fix the pooler config to restore real-time wakeups.'
      );
    }
  }

  // Initialize workspace provider
  await initWorkspaceProvider();

  // Initialize embedded Lobu gateway (requires DATABASE_URL)
  const { initLobuGateway } = await import('./lobu/gateway');
  const lobuApp = await initLobuGateway();
  if (lobuApp) {
    app.route('/lobu', lobuApp);
  }

  // Mount the main app after any embedded sub-app routes are registered.
  app.route('/', mainApp);

  // Boot the unified task scheduler. Every periodic platform-internal job —
  // token refresh, MCP DB cleanup, watcher automation, etc. — runs as a row
  // in `public.runs` (run_type='task') with cron-driven self-rescheduling.
  // Cross-pod coordination is the runs-queue claim path.
  const { getLobuCoreServices } = await import('./lobu/gateway');
  const { bootTaskScheduler } = await import('./scheduled/jobs');
  const taskScheduler = await bootTaskScheduler(getLobuCoreServices(), env);

  const port = parseInt(process.env.PORT || '8787', 10);
  const host = process.env.HOST?.trim() || '0.0.0.0';

  const honoListener = getRequestListener(app.fetch);
  const httpServer = http.createServer();
  // Increase keep-alive timeout so SSE streams (MCP) survive idle periods.
  // Node.js defaults to 5 s, which kills SSE GET connections before async
  // 202 tool-call responses can be delivered back via the stream.
  httpServer.keepAliveTimeout = 75_000; // 75 s — above typical 60 s LB idle timeout
  httpServer.headersTimeout = 76_000; // must be strictly > keepAliveTimeout

  let vite: any;

  // In development, start Vite dev server in middleware mode (same port, same process).
  // Vite handles its own paths (/@vite/*, source transforms, HMR).
  // Everything Vite doesn't match falls through to Hono via the appended middleware.
  if (process.env.NODE_ENV === 'development') {
    try {
      const { createServer } = await import('vite');
      vite = await createServer({
        root: resolveWebSourceRoot(),
        server: {
          middlewareMode: true,
          hmr: { server: httpServer },
        },
        appType: 'custom',
      });
      // Append Hono as the fallback — Vite handles its paths, rest goes to Hono
      vite.middlewares.use((req: http.IncomingMessage, res: http.ServerResponse) => {
        honoListener(req, res);
      });
      setViteDev(vite);
      httpServer.on('request', vite.middlewares);
      logger.info('Vite dev server started in middleware mode');
    } catch (err) {
      logger.warn({ err }, 'Failed to start Vite dev server — frontend will not be available');
    }
  }

  // Prod: Hono handles all requests directly
  if (!vite) {
    httpServer.on('request', honoListener);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal, stopping gracefully...');
    await vite?.close();
    taskScheduler.stop();
    const { stopLobuGateway } = await import('./lobu/gateway');
    await stopLobuGateway();
    const { closeDbSingleton } = await import('./db/client');
    await closeDbSingleton();
    httpServer.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Start HTTP server
  logger.info({ port }, 'Starting server');

  httpServer.listen(port, host, () => {
    logger.info({ host, port }, `Server running at http://${host}:${port}`);
  });
}

// Start the server
main().catch((error) => {
  logger.error({ error }, 'Failed to start server');
  process.exit(1);
});
