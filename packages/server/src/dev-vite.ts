/**
 * Shared Vite dev-server middleware wiring.
 *
 * `server.ts` uses this in development for both backends (external Postgres
 * and embedded Postgres). It attaches a Vite dev
 * server in middleware mode to the given HTTP server so the SPA is served with
 * HMR, and falls unmatched requests through to the Hono listener.
 */

import { existsSync } from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setViteDev } from './index';
import logger from './utils/logger';

// …/packages/server/src/dev-vite.ts → repo root
const PACKAGE_REPO_ROOT = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..'
);

function resolveWebSourceRoot(): string {
  const explicit = process.env.WEB_SOURCE_DIR?.trim();
  if (explicit) {
    if (!existsSync(path.join(explicit, 'index.html'))) {
      throw new Error(`WEB_SOURCE_DIR set but no index.html found: ${explicit}`);
    }
    return explicit;
  }

  const projectRoot = process.env.LOBU_DEV_PROJECT_PATH || PACKAGE_REPO_ROOT;
  const webSourceDir = path.resolve(projectRoot, 'packages/owletto');
  if (!existsSync(path.join(webSourceDir, 'index.html'))) {
    throw new Error(
      `Lobu web source directory not found: ${webSourceDir}. ` +
        `Set WEB_SOURCE_DIR or LOBU_DEV_PROJECT_PATH to the monorepo root.`
    );
  }
  return webSourceDir;
}

type HttpListener = (req: http.IncomingMessage, res: http.ServerResponse) => void;

/**
 * In development, start a Vite dev server in middleware mode on `httpServer`,
 * appending `honoListener` as the fallback for everything Vite doesn't handle.
 * Returns the Vite server (so the caller can `.close()` it on shutdown) or
 * `null` when not in development or when Vite failed to start — in which case
 * the caller MUST wire `honoListener` onto `httpServer` itself.
 */
export async function mountViteDev(
  httpServer: http.Server,
  honoListener: HttpListener
): Promise<{ close: () => Promise<void> } | null> {
  if (process.env.NODE_ENV !== 'development') return null;
  // A bundled CLI (`lobu run` from an npm install) ships the prebuilt SPA and
  // points WEB_DIST_DIR at it; the Hono app serves that statically. There is no
  // SPA *source* to run Vite against — and no HMR wanted for a prebuilt run — so
  // skip Vite entirely. Otherwise we'd probe for `packages/owletto`, fail, and
  // log a misleading "frontend will not be available" error even though the
  // frontend is in fact served from the bundle.
  if (process.env.WEB_DIST_DIR?.trim()) {
    logger.info(
      { webDistDir: process.env.WEB_DIST_DIR.trim() },
      'Serving prebuilt SPA from WEB_DIST_DIR — skipping Vite dev server'
    );
    return null;
  }
  try {
    const { createServer } = await import('vite');
    const vite = await createServer({
      root: resolveWebSourceRoot(),
      server: {
        middlewareMode: true,
        hmr: { server: httpServer },
        // The worker scratch dir (packages/server/workspaces/<agent>/.openclaw/*)
        // is written constantly while an agent runs; without this Vite triggers
        // a full browser page reload on every session.jsonl write, which kills
        // the in-flight chat SSE connection.
        watch: {
          ignored: [
            '**/workspaces/**',
            '**/.openclaw/**',
            '**/dist/**',
            '**/node_modules/**',
          ],
        },
      },
      appType: 'custom',
    });
    // Append Hono as the fallback — Vite handles its paths, rest goes to Hono.
    vite.middlewares.use((req: http.IncomingMessage, res: http.ServerResponse) => {
      honoListener(req, res);
    });
    setViteDev(vite);
    httpServer.on('request', vite.middlewares);
    logger.info('Vite dev server started in middleware mode');
    return vite;
  } catch (err) {
    logger.warn({ err }, 'Failed to start Vite dev server — frontend will not be available');
    return null;
  }
}
