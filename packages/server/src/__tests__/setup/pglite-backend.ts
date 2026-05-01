/**
 * Ephemeral PGlite backend for tests.
 *
 * Starts an in-memory PGlite instance fronted by PGLiteSocketServer so any
 * postgres.js client (test code, app code, migrations) can talk to it via a
 * plain DATABASE_URL. Lets the same integration tests run against either
 * real Postgres or PGlite without branching in the test code itself.
 *
 * Shape mirrors the production embedded path in src/start-local.ts so the
 * two stay behaviorally aligned (same extensions, same SSL/prepare flags).
 */

import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { vector } from '@electric-sql/pglite/vector';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function isTruthyEnv(name: string): boolean {
  return /^(1|true|yes|on)$/i.test(process.env[name]?.trim() ?? '');
}

const SOCKET_MAX_CONNECTIONS = readPositiveIntEnv('OWLETTO_PGLITE_SOCKET_MAX_CONNECTIONS', 64);
const SOCKET_IDLE_TIMEOUT_MS = readPositiveIntEnv('OWLETTO_PGLITE_SOCKET_IDLE_TIMEOUT_MS', 0);
const SOCKET_DEBUG = isTruthyEnv('OWLETTO_PGLITE_SOCKET_DEBUG');

export interface PgliteBackend {
  url: string;
  stop: () => Promise<void>;
}

let active: PgliteBackend | null = null;

/**
 * Start an ephemeral PGlite + socket server and return a DATABASE_URL any
 * postgres.js client can connect to. Idempotent: repeated calls return the
 * same instance until `stop()` runs.
 */
export async function startPgliteBackend(): Promise<PgliteBackend> {
  if (active) return active;

  const db = await PGlite.create({
    // No dataDir → purely in-memory; tests are hermetic and leave no trace.
    extensions: { vector, pg_trgm },
  });

  const socketServer = new PGLiteSocketServer({
    db,
    port: 0, // ephemeral; the listening event reports the real port
    maxConnections: SOCKET_MAX_CONNECTIONS,
    idleTimeout: SOCKET_IDLE_TIMEOUT_MS,
    debug: SOCKET_DEBUG,
  });

  socketServer.addEventListener('error', (event: Event) => {
    const detail = (event as CustomEvent).detail;
    console.error('[pglite-backend] socket server error', detail);
  });
  socketServer.addEventListener('close', () => {
    if (SOCKET_DEBUG) {
      console.warn('[pglite-backend] socket server closed');
    }
  });
  if (SOCKET_DEBUG) {
    socketServer.addEventListener('connection', (event: Event) => {
      const detail = (event as CustomEvent).detail;
      console.log('[pglite-backend] socket connection', {
        detail,
        stats: socketServer.getStats(),
      });
    });
  }

  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('PGlite socket server did not start within 10s')),
      10_000
    );
    socketServer.addEventListener('listening', (event: Event) => {
      clearTimeout(timer);
      const detail = (event as CustomEvent).detail as { port?: number } | undefined;
      if (typeof detail?.port === 'number') {
        resolve(detail.port);
      } else {
        reject(new Error('PGlite listening event missing port'));
      }
    });
    void socketServer.start();
  });

  // sslmode=disable is required — the socket doesn't speak SSL.
  const url = `postgresql://postgres@127.0.0.1:${port}/postgres?sslmode=disable`;

  active = {
    url,
    stop: async () => {
      try {
        await socketServer.stop();
      } finally {
        await db.close();
        active = null;
      }
    },
  };
  return active;
}
