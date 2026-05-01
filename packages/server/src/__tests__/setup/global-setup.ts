/**
 * Global Test Setup
 *
 * Runs once before all tests to set up the test database. Supports two
 * interchangeable backends so the same integration tests can execute against
 * either:
 *
 *   - `postgres` (default) — external Postgres via DATABASE_URL. Matches the
 *     historical test contract; full-suite compatible.
 *   - `pglite` (opt-in via `pnpm test:pglite` / OWLETTO_TEST_BACKEND=pglite) —
 *     ephemeral in-memory PGlite + socket server. Zero external dependencies.
 *     Currently reliable for targeted runs (e.g. the PostgresSecretStore
 *     suite); the full integration suite under a single vitest worker still
 *     exhausts the PGlite socket's connection pool, so it's not yet the
 *     default.
 *
 * The rest of the test suite is backend-agnostic: it reads DATABASE_URL and
 * uses postgres.js, so migrations, fixtures, and assertions are reused as-is.
 */

import { closeDbSingleton } from '../../db/client';
import { type PgliteBackend, startPgliteBackend } from './pglite-backend';
import { closeTestDb, setupTestDatabase } from './test-db';

let pglite: PgliteBackend | null = null;

function resolveBackend(): 'pglite' | 'postgres' {
  const explicit = process.env.OWLETTO_TEST_BACKEND?.trim().toLowerCase();
  if (explicit === 'pglite' || explicit === 'postgres') return explicit;
  // Default to external Postgres — matches the historical test contract.
  // Opt into PGlite explicitly via `pnpm test:pglite`.
  return 'postgres';
}

export async function setup(): Promise<void> {
  if (process.env.SKIP_TEST_DB_SETUP === '1') {
    console.log('\n⚠️  Skipping test database setup (SKIP_TEST_DB_SETUP=1).\n');
    return;
  }

  const backend = resolveBackend();

  if (backend === 'pglite') {
    console.log('\n🧬 Starting ephemeral PGlite backend for tests...');
    pglite = await startPgliteBackend();
    process.env.DATABASE_URL = pglite.url;
    // Matches the production embedded path in src/start-local.ts — the
    // PGlite socket doesn't support SSL negotiation or prepared statements.
    process.env.PGSSLMODE = 'disable';
    process.env.OWLETTO_DISABLE_PREPARE = '1';
    console.log(`✅ PGlite ready at ${pglite.url}`);
  } else {
    const databaseUrl = process.env.DATABASE_URL?.trim();
    if (!databaseUrl) {
      throw new Error(
        'OWLETTO_TEST_BACKEND=postgres requires DATABASE_URL. ' +
          'Example: DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5433/owletto_test'
      );
    }
    process.env.DATABASE_URL = databaseUrl;
    console.log(`\n🗄️  Using external Postgres at ${databaseUrl}`);
  }

  // Deterministic 32-byte hex key for AES-256-GCM in tests. Same value the
  // gateway's secret-store test harness uses so behavior is aligned.
  if (!process.env.ENCRYPTION_KEY) {
    process.env.ENCRYPTION_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
  }

  console.log('🗄️  Running migrations...');
  await setupTestDatabase();
  console.log('✅ Test database ready.\n');

  // Close setup-side connections so forked test workers can connect cleanly.
  await closeTestDb();
  await closeDbSingleton();
}

export async function teardown(): Promise<void> {
  if (pglite) {
    await pglite.stop();
    pglite = null;
  }
}
