/**
 * Bun:test PG harness shared across the gateway test suite.
 *
 * Store tests in this directory read/write Postgres directly, so callers
 * need a real DB. The first time `ensureDbForGatewayTests()` is called we use
 * DATABASE_URL if set, else spawn an ephemeral embedded Postgres once per test
 * process, run migrations, and reuse it for the rest of the suite.
 *
 * Tests that don't need PG (pure helpers, classification logic, etc.) can
 * skip calling this entirely and pay no cost.
 *
 * Suite teardown is registered in bun-test-teardown.ts (bunfig preload).
 * startEmbeddedBackend's beforeExit/exit hooks are a fallback on interrupt.
 */

import { closeDbSingleton, getDb } from "../../../db/client.js";
import {
  type EmbeddedBackend,
  startEmbeddedBackend,
  stopActiveEmbeddedBackend,
} from "../../../__tests__/setup/embedded-postgres-backend.js";
import {
  cleanupTestDatabase,
  closeTestDb,
  setupTestDatabase,
} from "../../../__tests__/setup/test-db.js";

let initPromise: Promise<void> | null = null;
let backend: EmbeddedBackend | null = null;

/**
 * Idempotent. Starts the DB + runs migrations on first call, returns the
 * same Promise on every subsequent call. Tests should `await` it from a
 * `beforeAll` — repeated calls are cheap.
 */
export function ensureDbForGatewayTests(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    if (!process.env.DATABASE_URL) {
      backend = await startEmbeddedBackend();
      process.env.DATABASE_URL = backend.url;
      process.env.PGSSLMODE = "disable";
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
  })().catch(async (err) => {
    await stopDbForGatewayTests();
    throw err;
  });

  return initPromise;
}

/** Stop and forget the embedded gateway-test database, if this process owns one. */
export async function stopDbForGatewayTests(): Promise<void> {
  const embeddedUrl = backend?.url;
  await closeTestDb();
  await closeDbSingleton();
  if (backend) {
    await stopActiveEmbeddedBackend();
  }
  if (embeddedUrl && process.env.DATABASE_URL === embeddedUrl) {
    delete process.env.DATABASE_URL;
  }
  backend = null;
  initPromise = null;
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
  if (!process.env.DATABASE_URL || !initPromise) {
    await ensureDbForGatewayTests();
  } else {
    await initPromise;
  }
  await cleanupTestDatabase();
}

/**
 * Convenience for tests that need an org_id present in `organizations` and
 * a row in `agents` so the FK-constrained tables (agent_users,
 * agent_channel_bindings, grants, etc.) accept inserts.
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
      id, organization_id, name, owner_platform, owner_user_id
    )
    VALUES (
      ${agentId}, ${orgId}, ${options.name ?? agentId},
      ${options.ownerPlatform ?? null}, ${options.ownerUserId ?? null}
    )
    ON CONFLICT (organization_id, id) DO NOTHING
  `;
  return orgId;
}

/**
 * Seed a `github` connector_definitions row whose feeds_schema carries the
 * webhook routing (`webhook: { events, mode }`) + the person attribution rule —
 * the exact persisted surface the app-webhook router reads (routing via
 * loadGithubWebhookRoutes, the rule via loadAttributionRuleByType). Mirrors the
 * real github connector's declarations so the gateway tests exercise the
 * DB-driven path, not a server-side hardcode.
 */
export async function seedGithubConnectorDef(orgId: string): Promise<void> {
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${orgId}, ${orgId}, ${orgId})
    ON CONFLICT (id) DO NOTHING
  `;
  const personAttribution = {
    role: "authored_by",
    autoCreate: true,
    target: {
      entityType: "person",
      titlePath: "metadata.author_login",
      identities: [
        { namespace: "github_user_id", eventPath: "metadata.author_id", primary: true },
        { namespace: "github_login", eventPath: "metadata.author_login" },
      ],
    },
    traits: {
      github_login: { eventPath: "metadata.author_login", behavior: "prefer_non_empty" },
      last_authored_at: { eventPath: "occurred_at", behavior: "overwrite" },
    },
  };
  const kind = (k: string) => ({ eventKinds: { [k]: { attributions: [personAttribution] } } });
  const feedsSchema = {
    issues: { key: "issues", name: "Issues", webhook: { events: ["issues"] }, ...kind("issue") },
    pull_requests: {
      key: "pull_requests",
      name: "Pull Requests",
      webhook: { events: ["pull_request"] },
      ...kind("pull_request"),
    },
    issue_comments: {
      key: "issue_comments",
      name: "Issue Comments",
      webhook: { events: ["issue_comment"] },
      ...kind("issue_comment"),
    },
    pr_comments: {
      key: "pr_comments",
      name: "PR Comments",
      webhook: { events: ["pull_request_review_comment"] },
      ...kind("pr_comment"),
    },
    commits: { key: "commits", name: "Commits", webhook: { events: ["push"] }, ...kind("commit") },
    stargazers: {
      key: "stargazers",
      name: "Stargazers",
      webhook: { events: ["star", "watch"], mode: "store" },
      ...kind("stargazer"),
    },
  };
  await sql`
    INSERT INTO connector_definitions (
      organization_id, key, name, version, feeds_schema, status, created_at, updated_at
    ) VALUES (
      ${orgId}, 'github', 'GitHub', '1.0.0', ${sql.json(feedsSchema)}, 'active', NOW(), NOW()
    )
    ON CONFLICT DO NOTHING
  `;
}
