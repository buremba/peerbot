/**
 * Ephemeral embedded-Postgres backend for tests.
 *
 * Spawns a real PostgreSQL 18 (embedded-postgres) on a throwaway datadir and
 * returns a plain DATABASE_URL any postgres.js client can use — so `make test`
 * needs no external Postgres, exactly like `lobu run`. Same binary + pgvector
 * injection as the production embedded path (src/embedded-runtime.ts), so tests
 * exercise the real engine (prepared statements, multi-conn pool, LISTEN/NOTIFY,
 * cube/earthdistance, pgvector) with no PGlite-specific quirks.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectPgvector, resolveEmbeddedNativeDir } from '@lobu/pgvector-embedded';
import EmbeddedPostgres from 'embedded-postgres';
import { withFreePortRetry } from './free-port';

export interface EmbeddedBackend {
  url: string;
  stop: () => Promise<void>;
}

let active: EmbeddedBackend | null = null;

/**
 * Start an ephemeral embedded Postgres and return a connectable DATABASE_URL.
 * Idempotent: repeated calls return the same instance until `stop()` runs.
 */
export async function startEmbeddedBackend(): Promise<EmbeddedBackend> {
  if (active) return active;

  injectPgvector(resolveEmbeddedNativeDir());

  // embedded-postgres needs a concrete port at construction. Ask the OS for a
  // free one and retry on collision rather than picking a random high port and
  // failing loud — under concurrent test load that races to EADDRINUSE (#976).
  // Each attempt gets a fresh datadir because initdb refuses a reused one.
  const { pg, port, dataDir } = await withFreePortRetry(async (candidate) => {
    const dir = mkdtempSync(join(tmpdir(), 'lobu-test-pg-'));
    // embedded-postgres rejects start() with `undefined` on ANY early exit —
    // a port collision included — so the OS-level EADDRINUSE never reaches the
    // catch. Capture stderr and re-tag a bind failure as EADDRINUSE so the
    // retry wrapper actually retries; surface anything else as a real error.
    let log = '';
    const instance = new EmbeddedPostgres({
      databaseDir: dir,
      user: 'postgres',
      password: 'postgres',
      port: candidate,
      persistent: false,
      onLog: (message) => {
        log += message;
      },
    });
    try {
      await instance.initialise();
      await instance.start();
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      if (/address already in use|could not bind/i.test(log)) {
        throw Object.assign(new Error(`embedded-postgres: port ${candidate} in use`), {
          code: 'EADDRINUSE',
        });
      }
      throw err instanceof Error
        ? err
        : new Error(`embedded-postgres failed to start: ${log.slice(-500) || 'no output'}`);
    }
    return { pg: instance, port: candidate, dataDir: dir };
  });

  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
  active = {
    url,
    stop: async () => {
      try {
        await pg.stop();
      } finally {
        rmSync(dataDir, { recursive: true, force: true });
        active = null;
      }
    },
  };
  return active;
}
