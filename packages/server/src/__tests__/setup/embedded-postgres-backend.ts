/**
 * Ephemeral embedded-Postgres backend for tests.
 *
 * Spawns a real PostgreSQL 18 (embedded-postgres) on a throwaway datadir and
 * returns a plain DATABASE_URL any postgres.js client can use — so `make test`
 * needs no external Postgres, exactly like `lobu run`. Same binary + pgvector
 * injection as the production embedded path (src/embedded-runtime.ts), so tests
 * exercise the real engine (prepared statements, multi-conn pool, LISTEN/NOTIFY,
 * cube/earthdistance, pgvector).
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { injectPgvector, resolveEmbeddedNativeDir } from '@lobu/pgvector-embedded';
import exitHook from 'async-exit-hook';
import EmbeddedPostgres from 'embedded-postgres';
import { withFreePortRetry } from './free-port';

// Importing `embedded-postgres` registers async-exit-hook, whose `beforeExit`
// handler force-exits with code 0 (`process.nextTick(process.exit.bind(null, 0))`).
// Because the vitest globalSetup imports this module, that hook lives in the
// MAIN vitest process: after a failed run vitest sets `process.exitCode = 1`
// and lets the loop drain, Node emits `beforeExit`, and the hook overwrites the
// failure with exit 0 — CI went green on a run with 8 failed tests (#1216).
// The `exit` hook is removed too: it calls the async gracefulShutdown without
// a `done` callback (`done is not a function` unhandled rejection on every
// clean run), and async cleanup can't execute during `exit` anyway. Signal
// hooks (SIGINT/SIGTERM/SIGHUP) stay so Ctrl-C still stops embedded clusters;
// the normal path stops them explicitly in teardown().
exitHook.unhookEvent('beforeExit');
exitHook.unhookEvent('exit');

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
      // Create a dedicated, test-named database. The harness runs
      // `DROP SCHEMA public CASCADE`, guarded by assertSafeTestDatabaseUrl which
      // only accepts databases whose name marks them as test/CI. The embedded
      // cluster's default db is `postgres`, which the guard (rightly) rejects —
      // so without this, `make test`/`make review` against the ephemeral backend
      // fail before a single test runs. A `*_test` name satisfies the guard
      // naturally, keeping the prod-wipe protection intact (no destructive
      // override needed).
      await instance.createDatabase('lobu_test');
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

  const url = `postgresql://postgres:postgres@127.0.0.1:${port}/lobu_test?sslmode=disable`;
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
