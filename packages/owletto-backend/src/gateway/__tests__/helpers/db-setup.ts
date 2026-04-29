/**
 * Bun:test PG harness shared across the gateway test suite.
 *
 * Some store tests in this directory previously ran entirely on a
 * MockRedisClient. After Phase 6 the stores read/write Postgres directly,
 * so callers need a real DB. We boot an ephemeral PGlite once per test
 * process the first time `ensurePgliteForGatewayTests()` is called, run
 * migrations, and reuse it for the rest of the suite.
 *
 * Tests that don't need PG (pure helpers, classification logic, etc.) can
 * skip calling this entirely and pay no cost.
 */

import { closeDbSingleton, getDb } from "../../../db/client.js";
import {
  startPgliteBackend,
  type PgliteBackend,
} from "../../../__tests__/setup/pglite-backend.js";
import {
  cleanupTestDatabase,
  closeTestDb,
  setupTestDatabase,
} from "../../../__tests__/setup/test-db.js";

let initPromise: Promise<void> | null = null;
let backend: PgliteBackend | null = null;

/**
 * Idempotent. Starts PGlite + runs migrations on first call, returns the
 * same Promise on every subsequent call. Tests should `await` it from a
 * `beforeAll` — repeated calls are cheap.
 */
export function ensurePgliteForGatewayTests(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!process.env.DATABASE_URL) {
      backend = await startPgliteBackend();
      process.env.DATABASE_URL = backend.url;
      process.env.PGSSLMODE = "disable";
      process.env.OWLETTO_DISABLE_PREPARE = "1";
    }
    if (!process.env.ENCRYPTION_KEY) {
      process.env.ENCRYPTION_KEY =
        "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    }
    await setupTestDatabase();
    // Hand the schema-ready DATABASE_URL off to the singleton without keeping
    // setup-time connections around.
    await closeTestDb();
    await closeDbSingleton();
  })();

  return initPromise;
}

/**
 * Idempotent ENCRYPTION_KEY guard. Some bun:test files in this directory
 * `delete process.env.ENCRYPTION_KEY` in their afterAll, which breaks any
 * subsequent file that lazily reads it. Call this at the start of beforeEach
 * (or beforeAll) in any file that uses encrypt()/decrypt() or stores that
 * route through the secret store.
 */
export function ensureEncryptionKey(): void {
  if (!process.env.ENCRYPTION_KEY) {
    process.env.ENCRYPTION_KEY =
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  }
}

/** Truncate every test-known table without dropping the schema. */
export async function resetTestDatabase(): Promise<void> {
  await cleanupTestDatabase();
}

/**
 * Convenience for tests that need an org_id present in `organizations` and
 * a row in `agents` so the FK-constrained tables (agent_users,
 * agent_channel_bindings, agent_grants, etc.) accept inserts.
 *
 * Returns the org_id used; defaults to "test-org".
 */
export async function seedAgentRow(
  agentId: string,
  options: {
    organizationId?: string;
    name?: string;
    ownerPlatform?: string;
    ownerUserId?: string;
    parentConnectionId?: string;
    templateAgentId?: string;
  } = {}
): Promise<string> {
  const sql = getDb();
  const orgId = options.organizationId ?? "test-org";

  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${orgId}, ${orgId}, ${orgId})
    ON CONFLICT (id) DO NOTHING
  `;

  await sql`
    INSERT INTO agents (
      id, organization_id, name, owner_platform, owner_user_id,
      parent_connection_id, template_agent_id
    )
    VALUES (
      ${agentId}, ${orgId}, ${options.name ?? agentId},
      ${options.ownerPlatform ?? null}, ${options.ownerUserId ?? null},
      ${options.parentConnectionId ?? null}, ${options.templateAgentId ?? null}
    )
    ON CONFLICT (id) DO NOTHING
  `;
  return orgId;
}
