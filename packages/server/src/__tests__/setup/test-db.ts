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
          'Example: DATABASE_URL=postgresql://localhost:5432/owletto_test'
      );
    }
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

  // Drop and recreate public schema
  await db`DROP SCHEMA IF EXISTS public CASCADE`;
  await db`CREATE SCHEMA public`;

  // Enable required extensions
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

    const normalizedUpSection = loadMigrationUpSection(migrationsDir, file);

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
  // Clear cached MCP sessions so stale auth contexts don't leak between test files
  const { clearMcpSessions } = await import('./test-helpers');
  clearMcpSessions();
  const { clearInMemoryMcpSessionsForTests } = await import('../../mcp-handler');
  clearInMemoryMcpSessionsForTests();
  // Multi-tenant auth TTL caches (orgSlug/memberRole/owner/session) survive across
  // requests by design. Without this, a test that recreates the org with the same slug
  // but a different UUID gets a 403 because requests still see the stale orgId.
  const { clearMultiTenantCachesForTests } = await import('../../workspace/multi-tenant');
  clearMultiTenantCachesForTests();

  const db = getTestDb();

  // Get all tables in public schema
  const tables = await db`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
    AND tablename NOT LIKE 'pg_%'
    AND tablename NOT LIKE 'schema_migrations%'
  `;

  // Disable triggers temporarily for faster truncation
  await db`SET session_replication_role = 'replica'`;

  if (tables.length > 0) {
    const quotedTables = tables.map(({ tablename }) => `"${tablename}"`).join(', ');
    try {
      await db.unsafe(`TRUNCATE ${quotedTables} CASCADE`);
    } catch {
      // Ignore errors for tables that may not exist.
    }
  }

  // Re-enable triggers
  await db`SET session_replication_role = 'origin'`;

  // Fix check constraints that are out-of-date relative to the app code
  await fixSchemaConstraints(db);
}

/**
 * Patch check constraints that the baseline migration defines too narrowly.
 * These ALTER statements are idempotent (drop + re-add).
 */
async function fixSchemaConstraints(db: postgres.Sql): Promise<void> {
  try {
    // runs.run_type needs the connector lanes plus the lobu-queue lanes that
    // landed in the Phase 5 redis -> runs migration. Keep this in sync with
    // db/migrations/20260429060000_extend_runs_for_lobu_queue.sql.
    await db.unsafe(`
      ALTER TABLE IF EXISTS runs DROP CONSTRAINT IF EXISTS runs_run_type_check;
      ALTER TABLE IF EXISTS runs ADD CONSTRAINT runs_run_type_check
        CHECK (run_type IN (
          'sync','action','watcher','embed_backfill','auth',
          'chat_message','schedule','agent_run','internal'
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
