/**
 * Reproducer + regression coverage for lobu-ai/lobu#1179.
 *
 * The scaffolded AGENTS.md documents a `rest` platform binding
 * (`{ type: "rest", config: {} }` — the HTTP Agent API) and `lobu validate`
 * accepts it, but `lobu apply` failed server-side:
 *
 *   PUT /api/<org>/agents/<id>/platforms/by-stable-id/<id>-rest
 *   → 400 "Unsupported platform: rest"
 *
 * because ChatInstanceManager.addConnection() rejected any platform without
 * an ADAPTER_FACTORIES entry and startInstance() eagerly booted a chat
 * adapter. `rest` is now a first-class adapterless platform: the row is
 * persisted, but no chat instance is ever created.
 *
 * Unlike agent-routes-apply.test.ts (which installs a delegating manager
 * stub), these tests wire the REAL ChatInstanceManager into the route so the
 * `Unsupported platform` guard and the startInstance() skip are actually
 * exercised end-to-end:
 *
 *   1. PUT by-stable-id with type `rest` succeeds (201) and persists the row
 *      — and no chat instance is registered for it.
 *   2. Re-applying the same body is idempotent (200 noop).
 *   3. Boot reconciliation (a fresh manager's initialize(), i.e. another
 *      replica or the next deploy) keeps the rest row `active` — it is not
 *      treated as a perpetually-failing adapter start.
 *   4. The start/stop run-state endpoints don't crash on an adapterless row.
 *   5. Genuinely unknown platforms are still rejected with
 *      "Unsupported platform: …" (other platform types unaffected).
 *
 * Uses the embedded Postgres gateway test harness; no network.
 */

import { beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  ensureDbForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup.js';
// Shared module mocks — see helpers/route-test-mocks.ts. This file previously
// re-mocked `../../auth/middleware` / `../gateway` with its own closures, but
// the cached agent-routes module stayed bound to agent-routes-apply.test.ts's
// mocks (bun mock.module is process-global, module evaluation is cached), so
// every request here authenticated under the OTHER file's stash (wrong org)
// and 404'd when both files ran in one process. The shared stashes below are
// set per-test in beforeEach instead; the manager installed is the REAL
// ChatInstanceManager built by buildRealManager().
import {
  authStash,
  chatManagerStash,
  installRouteTestMocks,
} from './helpers/route-test-mocks';

installRouteTestMocks();

const TEST_ENCRYPTION_KEY =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

const ORG = 'org-rest';
const AGENT = 'rest-agent';
const STABLE_ID = `${AGENT}-rest`;

beforeAll(async () => {
  await ensureDbForGatewayTests();
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
}, 60_000);

async function importAgentRoutes() {
  const mod = await import('../agent-routes.js');
  return mod.agentRoutes;
}

async function seedOrgAndAgent(orgId: string, agentId: string): Promise<void> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${orgId}, ${orgId}, ${orgId})
    ON CONFLICT (id) DO NOTHING
  `;
  await sql`
    INSERT INTO agents (id, organization_id, name)
    VALUES (${agentId}, ${orgId}, ${agentId})
    ON CONFLICT (organization_id, id) DO NOTHING
  `;
}

/**
 * Real ChatInstanceManager over the real Postgres stores — startInstance is
 * NOT stubbed, so an adapter-requiring platform would actually try to boot.
 * Mirrors the buildManager() harness in chat-instance-manager-config.test.ts.
 */
async function buildRealManager() {
  const { ChatInstanceManager } = await import(
    '../../gateway/connections/chat-instance-manager.js'
  );
  const { createPostgresAgentConnectionStore } = await import(
    '../stores/postgres-stores.js'
  );
  const { PostgresSecretStore } = await import(
    '../stores/postgres-secret-store.js'
  );
  const { SecretStoreRegistry } = await import('../../gateway/secrets/index.js');
  const { orgContext } = await import('../stores/org-context.js');

  const connectionStore = createPostgresAgentConnectionStore();
  const postgresSecretStore = new PostgresSecretStore();
  const secretStore = new SecretStoreRegistry(postgresSecretStore, {
    secret: postgresSecretStore,
  });

  const services = {
    getPublicGatewayUrl: () => '',
    getSecretStore: () => secretStore,
    getConnectionStore: () => connectionStore,
    getChannelBindingService: () => ({ getBinding: async () => null }),
    getCommandRegistry: () => undefined,
  } as any;

  const manager = new ChatInstanceManager() as any;
  manager.services = services;
  manager.publicGatewayUrl = '';
  manager.connectionStore = connectionStore;
  manager.slackCoordinator = manager.buildSlackCoordinator();

  return { manager, services, connectionStore, orgContext };
}

async function putRestPlatform(app: any, stableId: string = STABLE_ID) {
  return app.request(`/${AGENT}/platforms/by-stable-id/${stableId}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ platform: 'rest', config: {} }),
  });
}

beforeEach(async () => {
  await resetTestDatabase();
  await seedOrgAndAgent(ORG, AGENT);
  authStash.user = { id: 'u1', name: 'Test', email: 'u1@test', emailVerified: true };
  authStash.organizationId = ORG;
  authStash.authSource = 'session';
  authStash.mcpAuthInfo = null;
  const { manager } = await buildRealManager();
  chatManagerStash.manager = manager;
}, 30_000);

describe('PUT /agents/:agentId/platforms/by-stable-id — type rest (#1179)', () => {
  test('creates the platform row without instantiating a chat adapter', async () => {
    const app = await importAgentRoutes();

    const res = await putRestPlatform(app);
    expect(res.status).toBe(201);
    const body = (await res.json()) as any;
    expect(body.platform.id).toBe(STABLE_ID);
    expect(body.platform.platform).toBe('rest');
    expect(body.platform.status).toBe('active');

    // Persisted (visible to a plain store read in the same org)…
    const { connectionStore, orgContext } = await buildRealManager();
    const stored = await orgContext.run({ organizationId: ORG }, () =>
      connectionStore.getConnection(STABLE_ID)
    );
    expect(stored).not.toBeNull();
    expect(stored!.platform).toBe('rest');
    expect(stored!.status).toBe('active');

    // …but no chat instance was created: rest is adapterless.
    expect(chatManagerStash.manager.has(STABLE_ID)).toBe(false);
    expect(chatManagerStash.manager.getInstance(STABLE_ID)).toBeUndefined();
  });

  test('re-apply with the same body is an idempotent noop', async () => {
    const app = await importAgentRoutes();

    const first = await putRestPlatform(app);
    expect(first.status).toBe(201);

    const second = await putRestPlatform(app);
    expect(second.status).toBe(200);
    const body = (await second.json()) as any;
    expect(body.noop).toBe(true);
    expect(body.platform.id).toBe(STABLE_ID);

    // Still no instance after the re-apply.
    expect(chatManagerStash.manager.has(STABLE_ID)).toBe(false);
  });

  test('boot reconciliation on another replica keeps the rest row active', async () => {
    const app = await importAgentRoutes();
    expect((await putRestPlatform(app)).status).toBe(201);

    // A fresh manager booting from the same store — i.e. another replica, or
    // the next deploy. The rest row must come through `active` with no error
    // marker (not "perpetually failed to start"), and still adapterless.
    const { manager: replica, services, connectionStore, orgContext } =
      await buildRealManager();
    await replica.initialize(services);

    const stored = await orgContext.run({ organizationId: ORG }, () =>
      connectionStore.getConnection(STABLE_ID)
    );
    expect(stored).not.toBeNull();
    expect(stored!.status).toBe('active');
    expect(stored!.errorMessage ?? null).toBeNull();
    expect(replica.has(STABLE_ID)).toBe(false);
  });

  test('start/stop run-state endpoints work on an adapterless platform', async () => {
    const app = await importAgentRoutes();
    expect((await putRestPlatform(app)).status).toBe(201);

    const stop = await app.request(`/${AGENT}/platforms/${STABLE_ID}/stop`, {
      method: 'POST',
    });
    expect(stop.status).toBe(200);
    expect(((await stop.json()) as any).success).toBe(true);

    const start = await app.request(`/${AGENT}/platforms/${STABLE_ID}/start`, {
      method: 'POST',
    });
    expect(start.status).toBe(200);
    const startBody = (await start.json()) as any;
    expect(startBody.success).toBe(true);
    expect(startBody.platform.status).toBe('active');
    expect(chatManagerStash.manager.has(STABLE_ID)).toBe(false);
  });

  test('genuinely unknown platforms are still rejected', async () => {
    const app = await importAgentRoutes();

    const res = await app.request(
      `/${AGENT}/platforms/by-stable-id/${AGENT}-fax`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'fax', config: {} }),
      }
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toContain('Unsupported platform: fax');

    // The placeholder claim row is rolled back on failure.
    const { connectionStore, orgContext } = await buildRealManager();
    const stored = await orgContext.run({ organizationId: ORG }, () =>
      connectionStore.getConnection(`${AGENT}-fax`)
    );
    expect(stored).toBeNull();
  });
});
