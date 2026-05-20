/**
 * Test Database Utilities
 *
 * Provides setup, cleanup, and connection management for integration tests.
 * Uses a separate test database to avoid affecting development data.
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import postgres from 'postgres';
import { listMigrationFiles, loadMigrationUpSection } from '../../db/migration-loader';
import { clearInMemoryMcpSessionsForTests } from '../../mcp-session-state';
import { clearMultiTenantCachesForTests } from '../../workspace/multi-tenant-caches';
import { clearMcpSessions } from './mcp-session-cache';

/**
 * Walk up from startDir looking for `db/migrations`. Falls back to cwd so the
 * historical behaviour (vitest invoked from repo root) still works even when
 * no match is found upstream.
 */
function resolveMigrationsDir(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, 'db/migrations');
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(startDir, 'db/migrations');
}

const TEST_SEED_USER_ID = 'test-seed-user';
const TEST_SEED_USER_EMAIL = 'test-seed-user@example.com';
const SKIP_ON_FRESH_SETUP = new Set<string>();

let sql: postgres.Sql | null = null;

/**
 * Refuse to run the (destructive) test harness against anything that isn't an
 * obvious throwaway test database.
 *
 * `setupTestDatabase()` runs `DROP SCHEMA public CASCADE`. On 2026-05-20 a
 * developer ran the integration suite with `DATABASE_URL` pointed at the
 * production `owletto` database; the test role owns that DB, so the drop
 * succeeded and wiped 49 orgs / 1.15M events. There was no guard.
 *
 * Allow only databases whose name marks them as test/CI (anything containing
 * `test`, or ending `_ci`) — CI uses `lobu_test` / `lobu_ci`. Anything else
 * (e.g. `owletto`) is refused unless `LOBU_ALLOW_DESTRUCTIVE_TEST_DB=1` is set
 * as a deliberate, explicit override.
 */
export function assertSafeTestDatabaseUrl(url: string): void {
  if (process.env.LOBU_ALLOW_DESTRUCTIVE_TEST_DB === '1') return;
  let dbName: string;
  try {
    dbName = new URL(url).pathname.replace(/^\//, '').split('?')[0];
  } catch {
    // Unparseable URL — let the postgres client surface the connection error.
    return;
  }
  const looksLikeTestDb = /test/i.test(dbName) || /_ci$/i.test(dbName);
  if (!looksLikeTestDb) {
    throw new Error(
      `Refusing to run the integration test harness against database "${dbName}": ` +
        `setup runs DROP SCHEMA public CASCADE and would destroy its data. ` +
        `Point DATABASE_URL at a throwaway test database (name must contain "test", ` +
        `e.g. postgresql://localhost:5432/lobu_test). If this really is a disposable ` +
        `database, set LOBU_ALLOW_DESTRUCTIVE_TEST_DB=1 to override.`
    );
  }
}

function pgBool(value: unknown): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    return normalized === 't' || normalized === 'true' || normalized === '1';
  }
  if (typeof value === 'number') return value !== 0;
  return false;
}

/**
 * Get the test database client (singleton).
 * Reads DATABASE_URL lazily so global setup can validate it first.
 */
export function getTestDb(): postgres.Sql {
  if (!sql) {
    const url = process.env.DATABASE_URL;
    if (!url) {
      throw new Error(
        'DATABASE_URL is required for tests. Set it in your environment or .env file.\n' +
          'Example: DATABASE_URL=postgresql://localhost:5432/lobu_test'
      );
    }
    assertSafeTestDatabaseUrl(url);
    sql = postgres(url, {
      max: 5,
      idle_timeout: 20,
      // Integration tests trigger many CASCADE/TRUNCATE notices; suppress them to
      // reduce noisy output and hook slowdowns.
      onnotice: () => {},
    });
  }
  return sql;
}

/**
 * Close the test database connection and reset the singleton.
 * Used by global setup to free the connection for test workers.
 */
export async function closeTestDb(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
  }
}

/**
 * Setup the test database by running all migrations
 * Called once before all tests
 */
export async function setupTestDatabase(): Promise<void> {
  const db = getTestDb();

  // Reset the public schema to a clean slate before running migrations.
  //
  // Postgres 15+ removed the implicit CREATE privilege on schema `public` from
  // the `public` role: only the schema OWNER can run DDL there (including
  // DROP/CREATE SCHEMA). PGlite and superuser/owner connections can recreate
  // the whole schema; a plain (non-owner) connection user against a real PG15+
  // server cannot, and `DROP SCHEMA IF EXISTS public CASCADE` fails with
  // `must be owner of schema public`. Reset gracefully across all three.
  const ownsPublicSchema = await resetPublicSchema(db);

  // Enable required extensions. On a non-superuser connection these must already
  // be installed by the DBA; the IF NOT EXISTS guards make that a no-op rather
  // than a privilege error.
  await db`CREATE EXTENSION IF NOT EXISTS "vector"`;
  await db`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`;

  // Run migrations in order. Resolves `db/migrations` by walking up from the
  // current working directory so vitest works whether invoked at the repo
  // root or inside the package.
  const migrationsDir = resolveMigrationsDir(process.cwd());

  let migrationFiles: string[];
  try {
    migrationFiles = listMigrationFiles(migrationsDir);
  } catch (_err) {
    console.warn('No migrations directory found, skipping migrations');
    return;
  }

  for (const file of migrationFiles) {
    if (SKIP_ON_FRESH_SETUP.has(file)) {
      continue;
    }

    // Baseline migration comes from pg_dump and sets search_path to ''.
    // Reset it before each migration so follow-up files can use unqualified names.
    await db`SET search_path TO public`;

    await ensureSeedUserIfPossible(db);

    let normalizedUpSection = loadMigrationUpSection(migrationsDir, file);

    // When the connection user doesn't own schema `public` (PG15+ fresh
    // `createdb` where the postgres superuser still owns it), the baseline's
    // cosmetic `COMMENT ON SCHEMA public` / `COMMENT ON EXTENSION ...` lines
    // throw `must be owner of schema/extension`. These comments carry no
    // functional weight for tests, so drop them rather than require the test
    // role to be the schema owner.
    if (!ownsPublicSchema) {
      normalizedUpSection = stripOwnerOnlyComments(normalizedUpSection);
    }

    if (normalizedUpSection) {
      try {
        await db.unsafe(normalizedUpSection);
      } catch (err) {
        console.error(`Migration failed for ${file}:`, err);
        throw err;
      }
    }
  }
}

/**
 * Reset schema `public` to a clean slate, working whether the connection user
 * owns the schema or not. Returns whether the connection user ends up owning
 * `public` (true on PGlite / superuser / schema-owner connections).
 *
 * Preferred path (owner / superuser): take ownership of `public` if we can,
 * then DROP/CREATE the whole schema — the historical behaviour, which also
 * clears objects left by *other* roles.
 *
 * Fallback path (non-owner on PG15+): the user can't drop the schema, so drop
 * everything the test role owns inside `public` via `DROP OWNED BY CURRENT_USER`
 * (clears tables/types/sequences from prior runs) without touching the schema
 * object itself. Migrations re-create everything as the same role, so the next
 * run owns them again. Returns false so the caller strips the baseline's
 * owner-only `COMMENT ON SCHEMA/EXTENSION` lines, which would otherwise throw.
 */
async function resetPublicSchema(db: postgres.Sql): Promise<boolean> {
  // Best-effort: become the owner so the fast DROP/CREATE path works. Only the
  // current owner or a superuser may run this; if we lack the right it errors,
  // which is fine — we fall through to the non-owner path below.
  try {
    await db`ALTER SCHEMA public OWNER TO CURRENT_USER`;
  } catch {
    // not owner/superuser — handled by the fallback below
  }

  try {
    await db`DROP SCHEMA IF EXISTS public CASCADE`;
    await db`CREATE SCHEMA public`;
    return true;
  } catch (err) {
    // 42501 = insufficient_privilege ("must be owner of schema public").
    // Any other error is a real problem and should surface.
    const code = (err as { code?: string } | null)?.code;
    if (code !== '42501') throw err;
  }

  // Non-owner fallback: ensure the schema exists, then drop everything this
  // role owns inside it. DROP OWNED BY only touches objects owned by the
  // current role, so it never trips the schema-ownership check.
  await db`CREATE SCHEMA IF NOT EXISTS public`;
  await db`DROP OWNED BY CURRENT_USER`;
  return false;
}

/**
 * Remove `COMMENT ON SCHEMA`/`COMMENT ON EXTENSION` statements from a migration
 * body. These are cosmetic metadata that require schema/extension ownership;
 * stripping them lets a non-owner test role apply the baseline. Matches a
 * statement-leading `COMMENT ON {SCHEMA,EXTENSION}` through its terminating
 * semicolon (the comment text itself never contains a `;` in our baseline).
 */
function stripOwnerOnlyComments(sql: string): string {
  return sql.replace(/^\s*COMMENT ON (?:SCHEMA|EXTENSION)\b[^;]*;\s*$/gim, '');
}

async function ensureSeedUserIfPossible(db: postgres.Sql): Promise<void> {
  // Some migrations backfill `created_by` by selecting any user. Tests start with
  // an empty DB, so we seed one deterministic user once the auth table exists.
  try {
    const userTableRows = await db.unsafe<{ exists: boolean }[]>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.tables
          WHERE table_schema = 'public'
            AND table_name = 'user'
        ) AS exists
      `
    );
    if (!pgBool(userTableRows[0]?.exists)) return;

    const usernameColRows = await db.unsafe<{ exists: boolean }[]>(
      `
        SELECT EXISTS (
          SELECT 1
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'user'
            AND column_name = 'username'
        ) AS exists
      `
    );
    const hasUsernameColumn = pgBool(usernameColRows[0]?.exists);

    if (hasUsernameColumn) {
      // Insert both the test seed user and the 'system' user that migrations reference
      await db.unsafe(
        `
          INSERT INTO "user" (
            "id",
            "name",
            "email",
            "username",
            "emailVerified",
            "createdAt",
            "updatedAt"
          ) VALUES
            ($1, $2, $3, $4, true, NOW(), NOW()),
            ('system', 'System', 'system@localhost', 'system', true, NOW(), NOW())
          ON CONFLICT (id) DO NOTHING
        `,
        [TEST_SEED_USER_ID, 'Test Seed User', TEST_SEED_USER_EMAIL, 'test-seed-user']
      );
    } else {
      await db.unsafe(
        `
          INSERT INTO "user" (
            "id",
            "name",
            "email",
            "emailVerified",
            "createdAt",
            "updatedAt"
          ) VALUES
            ($1, $2, $3, true, NOW(), NOW()),
            ('system', 'System', 'system@localhost', true, NOW(), NOW())
          ON CONFLICT (id) DO NOTHING
        `,
        [TEST_SEED_USER_ID, 'Test Seed User', TEST_SEED_USER_EMAIL]
      );
    }
  } catch (error: unknown) {
    // The auth table may not exist yet when early migrations run.
    const code = (error as { code?: string } | null)?.code;
    if (code === '42P01' || code === '42703') {
      return;
    }
    throw error;
  }
}

/**
 * Clean up test database by truncating all tables
 * Called between tests to ensure isolation
 */
export async function cleanupTestDatabase(): Promise<void> {
  // All three clearers live in dedicated leaf modules so this path never
  // statically (or dynamically) loads `test-helpers`, `mcp-handler`, or
  // `workspace/multi-tenant` — those files transitively pull in
  // `@lobu/connector-sdk` via the full app graph, which breaks gateway-only
  // `bun:test` runs that don't have the workspace `dist/` built. The cache
  // *instances* are still the same singletons read/written by production
  // code; only the test clearer is exported from a leaf.
  clearMcpSessions();
  clearInMemoryMcpSessionsForTests();
  // Multi-tenant auth TTL caches (orgSlug/memberRole/owner/session) survive across
  // requests by design. Without this, a test that recreates the org with the same slug
  // but a different UUID gets a 403 because requests still see the stale orgId.
  clearMultiTenantCachesForTests();

  const db = getTestDb();

  // Get all tables in public schema
  const tables = await db`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    AND tablename NOT LIKE 'pg_%'
    AND tablename NOT LIKE 'schema_migrations%'
  `;

  // Disable triggers temporarily for faster truncation. `session_replication_role`
  // is superuser-only, so on a non-superuser test role (the PG15+ fresh-`createdb`
  // shape from #950, where DATABASE_URL points at a plain CREATE-granted user) this
  // throws `permission denied to set parameter` (42501). Treat it as best-effort:
  // `TRUNCATE ... CASCADE` already respects FK ordering on its own, so skipping the
  // trigger-disable only forgoes the speedup, never correctness.
  const triggersDisabled = await trySetReplicationRole(db, 'replica');

  if (tables.length > 0) {
    const quotedTables = tables.map(({ tablename }) => `"${tablename}"`).join(', ');
    try {
      await db.unsafe(`TRUNCATE ${quotedTables} CASCADE`);
    } catch {
      // Ignore errors for tables that may not exist.
    }
  }

  // Re-enable triggers only if we managed to disable them.
  if (triggersDisabled) {
    await trySetReplicationRole(db, 'origin');
  }

  // Fix check constraints that are out-of-date relative to the app code
  await fixSchemaConstraints(db);
}

/**
 * Best-effort `SET session_replication_role`. Returns true if the role was set,
 * false if the connection user lacks the superuser right (42501) — the caller
 * then proceeds without trigger-disabling, which is safe for `TRUNCATE CASCADE`.
 * Any other error is a real problem and surfaces.
 */
async function trySetReplicationRole(
  db: postgres.Sql,
  role: 'replica' | 'origin'
): Promise<boolean> {
  try {
    await db.unsafe(`SET session_replication_role = '${role}'`);
    return true;
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === '42501') return false;
    throw err;
  }
}

/**
 * Patch check constraints that the baseline migration defines too narrowly.
 * These ALTER statements are idempotent (drop + re-add).
 */
async function fixSchemaConstraints(db: postgres.Sql): Promise<void> {
  try {
    // runs.run_type needs the connector lanes plus the lobu-queue lanes. Keep
    // this in sync with db/migrations/20260429060000_extend_runs_for_lobu_queue.sql.
    await db.unsafe(`
      ALTER TABLE IF EXISTS runs DROP CONSTRAINT IF EXISTS runs_run_type_check;
      ALTER TABLE IF EXISTS runs ADD CONSTRAINT runs_run_type_check
        CHECK (run_type IN (
          'sync','action','watcher','embed_backfill','auth',
          'chat_message','schedule','agent_run','internal','task'
        ));
    `);
    // connections.status needs 'pending_auth'
    await db.unsafe(`
      ALTER TABLE IF EXISTS connections DROP CONSTRAINT IF EXISTS connections_status_check;
      ALTER TABLE IF EXISTS connections ADD CONSTRAINT connections_status_check
        CHECK (status IN ('active','paused','error','revoked','pending_auth'));
    `);
    // feeds.pinned_version column for trigger_feed
    await db.unsafe(`
      ALTER TABLE IF EXISTS feeds ADD COLUMN IF NOT EXISTS pinned_version text;
    `);
    // connect_tokens table for connect flow
    await db.unsafe(`
      CREATE TABLE IF NOT EXISTS connect_tokens (
        id bigserial PRIMARY KEY,
        token text NOT NULL UNIQUE,
        connection_id bigint NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
        organization_id text NOT NULL,
        connector_key text NOT NULL,
        auth_type text NOT NULL CHECK (auth_type IN ('oauth', 'env_keys')),
        auth_config jsonb,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'completed', 'expired')),
        created_by text,
        expires_at timestamp with time zone NOT NULL DEFAULT (now() + interval '1 hour'),
        completed_at timestamp with time zone,
        created_at timestamp with time zone NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS idx_connect_tokens_token ON connect_tokens (token);
      CREATE INDEX IF NOT EXISTS idx_connect_tokens_connection_id ON connect_tokens (connection_id);
    `);
  } catch {
    // Ignore if tables don't exist yet
  }
}
