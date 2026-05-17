/**
 * Node.js Server Entry Point
 *
 * This file starts the Hono server with @hono/node-server and sets up:
 * - HTTP server with environment injection
 * - Vite dev server in development (middleware mode, same port)
 * - Scheduled maintenance tasks
 * - Sentry error tracking
 */

// Refuse to boot under an unsupported Node major (isolated-vm gate). The
// module performs the check on load, so this side-effect import MUST be the
// first one — ESM evaluates sibling imports in textual order, so anything
// above this line would otherwise run first and could itself crash on the
// unsupported runtime.
import './utils/assert-node-version';

// Sentry must init before any other imports for auto-instrumentation
import './instrument';

import dotenv from 'dotenv';

dotenv.config();

import http from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import v8 from 'node:v8';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import { closeDbSingleton, getDb, probeListenNotify } from './db/client';
import { mountViteDev } from './dev-vite';
import type { Env } from './index';
import { app as mainApp } from './index';
import {
  getLobuCoreServices,
  initLobuGateway,
  stopLobuGateway,
} from './lobu/gateway';
import { bootTaskScheduler } from './scheduled/jobs';
import * as Sentry from '@sentry/node';
import { assertExternalDepsResolvable } from '../../connector-worker/src/runtime-deps';
import { isSentryReported, markSentryReported } from './sentry';
import { getEnvFromProcess } from './utils/env';
import logger from './utils/logger';
import { assertSchemaUpToDate } from './utils/schema-version-check';
import { initWorkspaceProvider } from './workspace';

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

// Inject environment variables into Hono context. The snapshot is immutable
// post-boot and callers only read it, so assign it by reference instead of
// spreading it onto a fresh `c.env` object on every request.
const env = getEnvFromProcess();
app.use('*', async (c, next) => {
  // @hono/node-server hands the request's IncomingMessage to handlers via
  // c.env.incoming (so `getConnInfo` can read socket.remoteAddress). The
  // assignment below replaces c.env with our app-wide config object, which
  // would lose that reference; stash the peer address in c.var first so
  // handlers that need the actual TCP peer (e.g. `/api/local-init`'s
  // loopback-peer defense) can still get at it.
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } })?.incoming;
  const peerRemoteAddress = incoming?.socket?.remoteAddress ?? null;
  if (peerRemoteAddress) c.set('peerRemoteAddress', peerRemoteAddress);
  c.env = env as Env;
  return next();
});

// Server-error capture. Two layers because routes split into two shapes:
//
//   (a) routes that throw and let the framework respond — caught by
//       `app.onError` below, preserving the full stack trace.
//   (b) routes that try/catch internally and `return c.json(..., 500)` — the
//       framework never sees the exception, so onError doesn't fire. The
//       post-response middleware below catches anything with `status >= 500`
//       so silent 500s still reach Sentry, even if the stack is gone.
//
// Either layer marks the request as reported so we don't double-count when
// both paths converge (e.g. an inner catch already called captureServerError).
app.use('*', async (c, next) => {
  await next();
  if (c.res.status >= 500 && !isSentryReported(c)) {
    let body: unknown = null;
    try {
      body = await c.res.clone().json();
    } catch {
      // response wasn't JSON; ignore
    }
    const message =
      (body && typeof body === 'object' && 'error' in body && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : null) ?? `HTTP ${c.res.status} from ${c.req.method} ${c.req.path}`;
    Sentry.captureMessage(message, {
      level: 'error',
      tags: {
        source: 'http_response',
        http_method: c.req.method,
        http_status: String(c.res.status),
      },
      extra: {
        path: c.req.path,
        url: c.req.url,
        response_body: body,
      },
    });
    markSentryReported(c);
  }
});

// Catch-all error handler for thrown exceptions that bubble past route catches.
// Preserves the original stack trace and returns a generic 500 so handlers
// don't have to remember to wrap themselves.
app.onError((err, c) => {
  if (!isSentryReported(c)) {
    Sentry.captureException(err, {
      tags: {
        source: 'app_onError',
        http_method: c.req.method,
      },
      extra: {
        path: c.req.path,
        url: c.req.url,
      },
    });
    markSentryReported(c);
  }
  // sentryReported:true tells the pino → Sentry forwarder in logger.ts
  // to skip — Sentry already has this exception via the explicit
  // captureException above. Without the marker, we'd send the same
  // event twice.
  logger.error({ err, path: c.req.path, sentryReported: true }, 'Unhandled error in HTTP handler');
  return c.json({ error: 'Internal server error' }, 500);
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

  // Refuse to boot if the image expects a migration the database hasn't
  // applied. Skippable via SKIP_SCHEMA_VERSION_CHECK=1 for emergency
  // forward-flight (e.g. rolling back to an older image whose migrations
  // dir is a strict prefix of what's already applied). See
  // utils/schema-version-check.ts for the 2026-05-16 incident this guards.
  if (process.env.SKIP_SCHEMA_VERSION_CHECK !== '1') {
    const migrationsDir =
      process.env.LOBU_MIGRATIONS_DIR?.trim() || path.join(PACKAGE_REPO_ROOT, 'db', 'migrations');
    await assertSchemaUpToDate(getDb(), { migrationsDir });
  } else {
    logger.warn('[schema-check] SKIP_SCHEMA_VERSION_CHECK=1 — skipping boot-time assertion');
  }

  // Verify LISTEN/NOTIFY actually delivers. This is a *detector*, not a gate:
  // the runs-queue has a 200ms SKIP-LOCKED poll fallback that keeps the queue
  // correct even when LISTEN is silently dropped (transaction-mode pgbouncer,
  // RDS Proxy, etc.). Failing the probe just means wakeup latency degrades to
  // the poll interval — not an outage. Log loudly so ops can fix the pooler
  // config, but do not refuse to boot.
  if (process.env.SKIP_LISTEN_NOTIFY_PROBE !== '1') {
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

  // In development this attaches a Vite dev server (middleware mode, HMR) and
  // returns it; in prod (or if Vite fails) it returns null and Hono handles
  // every request directly.
  const vite = await mountViteDev(httpServer, honoListener);
  if (!vite) {
    httpServer.on('request', honoListener);
  }

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Received shutdown signal, stopping gracefully...');
    await vite?.close();
    taskScheduler.stop();
    await stopLobuGateway();
    await closeDbSingleton();
    httpServer.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // SIGUSR2 → V8 heap snapshot. Off by default because snapshots contain
  // in-memory secrets (DB URL, OAuth tokens, secret-proxy cache) and
  // workers spawn as the same Linux UID. Operator opts in by setting
  // ALLOW_HEAP_SNAPSHOT=1 on the pod, sends `kubectl exec ... kill -USR2 1`,
  // copies the file out, then unsets the env / rolls the pod.
  //
  // Blocks the event loop for ~seconds (proportional to heap size) and
  // requires ~heap-size extra memory while writing. Don't trigger from a
  // pod close to the cgroup limit or it will OOM mid-snapshot. Trigger
  // also blocks /health/ready (DB SELECT 1) — drain via Service first if
  // multi-replica.
  //
  // Single-flight + fixed filename: subsequent signals while a snapshot is
  // in progress are ignored, and the path is `/tmp/lobu.heapsnapshot`
  // (overwritten each time) so a stuck-on flag can't fill the tmpfs.
  if (process.env.ALLOW_HEAP_SNAPSHOT === '1') {
    const SNAPSHOT_PATH = '/tmp/lobu.heapsnapshot';
    let inProgress = false;
    process.on('SIGUSR2', () => {
      if (inProgress) {
        logger.warn('[heap] SIGUSR2 ignored — snapshot already in progress');
        return;
      }
      inProgress = true;
      logger.warn(
        { path: SNAPSHOT_PATH },
        '[heap] SIGUSR2 received — writing heap snapshot (blocks event loop)'
      );
      try {
        v8.writeHeapSnapshot(SNAPSHOT_PATH);
        logger.warn({ path: SNAPSHOT_PATH }, '[heap] snapshot written');
      } catch (err) {
        logger.error({ err }, '[heap] writeHeapSnapshot failed');
      } finally {
        inProgress = false;
      }
    });
    logger.warn(
      '[heap] ALLOW_HEAP_SNAPSHOT=1 — SIGUSR2 will write heap dumps to ' +
        SNAPSHOT_PATH +
        '. Unset and roll the pod when done; snapshots contain secrets.'
    );
  }

  // Start HTTP server
  logger.info({ port }, 'Starting server');

  httpServer.listen(port, host, () => {
    logger.info({ host, port }, `Server running at http://${host}:${port}`);
    // Crash loud if the runtime image is missing any connector external dep,
    // instead of letting every feed silently fail with "Missing npm
    // dependency: X" hours later. Run this after listen() so the synchronous
    // require.resolve walk doesn't add to cold-boot/readiness latency.
    try {
      assertExternalDepsResolvable(createRequire(import.meta.url).resolve);
    } catch (err) {
      logger.error({ err }, 'Connector external dependency check failed');
      process.exit(1);
    }
  });
}

// Start the server
main().catch((error) => {
  logger.error({ error }, 'Failed to start server');
  process.exit(1);
});
