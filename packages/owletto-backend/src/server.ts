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

import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';
import type { Env } from './index';
import { app as mainApp, setViteDev } from './index';
import { getEnvFromProcess } from './utils/env';
import logger from './utils/logger';
import { initWorkspaceProvider } from './workspace';

// Create a wrapper app that injects environment into each request
const app = new Hono<{ Bindings: Env }>();
const APP_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

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

  // Initialize workspace provider
  await initWorkspaceProvider();

  // Initialize embedded Lobu gateway (requires REDIS_URL)
  const { initLobuGateway } = await import('./lobu/gateway');
  const lobuApp = await initLobuGateway();
  if (lobuApp) {
    app.route('/lobu', lobuApp);
  }

  // Mount the main app after any embedded sub-app routes are registered.
  app.route('/', mainApp);

  const { startMaintenanceScheduler } = await import('./scheduled/jobs');
  const stopMaintenanceScheduler = startMaintenanceScheduler(env);

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
        root: path.resolve(APP_ROOT, 'packages/web'),
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
    stopMaintenanceScheduler();
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
