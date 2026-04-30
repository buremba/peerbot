/**
 * Tests covering the two `lobu apply`-friendly extensions to lobu/agent-routes.ts:
 *
 *   1. POST /agents — same-org duplicate returns 200 (idempotent), cross-org
 *      collision still 409, and the Owletto MCP auto-injection only runs on
 *      the create path (never on the idempotent return).
 *   2. PUT /agents/:agentId/connections/by-stable-id/:stableId — caller-supplied
 *      stable-ID upsert. Same config → noop. Changed config → updated +
 *      willRestart. Missing → create with the supplied ID.
 *
 * PR-2 of `docs/plans/lobu-apply.md`.
 */

import { beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import {
  ensurePgliteForGatewayTests,
  resetTestDatabase,
} from '../../gateway/__tests__/helpers/db-setup.js';

// Stash for the mocked `mcpAuth` middleware. Each test sets the user/org it
// wants the route handler to see; the middleware below copies them onto the
// Hono context. Using a mutable holder keeps the mocked module trivial — no
// per-test re-mocking needed.
const authStash: {
  user: { id: string; name: string; email: string; emailVerified: boolean } | null;
  organizationId: string | null;
} = {
  user: { id: 'u1', name: 'Test', email: 'u1@test', emailVerified: true },
  organizationId: 'org-a',
};

mock.module('../../auth/middleware', () => ({
  mcpAuth: async (c: any, next: any) => {
    c.set('user', authStash.user);
    c.set('organizationId', authStash.organizationId);
    return next();
  },
  // requireAuth is referenced elsewhere in the module — provide a passthrough
  // so importing files that destructure it still get a function.
  requireAuth: async (_c: any, next: any) => next(),
}));

// `getChatInstanceManager` returns null in tests — this is the documented
// "no manager" fallback path that persists straight to the connection store.
// We don't need a real manager for these tests; the upsert + idempotent paths
// both have a no-manager branch that exercises the same correctness contract.
mock.module('../gateway', () => ({
  getChatInstanceManager: () => null,
  getLobuCoreServices: () => null,
  initLobuGateway: async () => null,
  stopLobuGateway: async () => {},
  isLobuGatewayRunning: () => false,
  ensureEmbeddedGatewaySecrets: () => {},
}));

const ORG_A = 'org-a';
const ORG_B = 'org-b';

beforeAll(async () => {
  await ensurePgliteForGatewayTests();
});

async function importAgentRoutes() {
  // Dynamic import after mock.module so the route module picks up the stubs.
  // ts-expect-error: dynamic import for test isolation
  const mod = await import('../agent-routes.js');
  return mod.agentRoutes;
}

async function seedOrg(orgId: string): Promise<void> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  await sql`
    INSERT INTO organization (id, name, slug)
    VALUES (${orgId}, ${orgId}, ${orgId})
    ON CONFLICT (id) DO NOTHING
  `;
}

async function seedAgent(orgId: string, agentId: string): Promise<void> {
  const { getDb } = await import('../../db/client.js');
  const sql = getDb();
  await sql`
    INSERT INTO agents (id, organization_id, name)
    VALUES (${agentId}, ${orgId}, ${agentId})
    ON CONFLICT (id) DO NOTHING
  `;
}

describe('POST /agents — idempotent same-org create', () => {
  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrg(ORG_A);
    await seedOrg(ORG_B);
    authStash.user = { id: 'u1', name: 'Test', email: 'u1@test', emailVerified: true };
    authStash.organizationId = ORG_A;
  });

  test('first POST creates 201, second returns 200 with existing payload', async () => {
    const app = await importAgentRoutes();

    const create = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'apply-agent',
        name: 'Apply Agent',
        description: 'first',
      }),
    });
    expect(create.status).toBe(201);
    const created = (await create.json()) as any;
    expect(created.agentId).toBe('apply-agent');
    expect(created.name).toBe('Apply Agent');

    // Second POST in the same org with a different name in the body should
    // still return the original metadata and NOT overwrite it (the idempotent
    // path doesn't re-save).
    const second = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        agentId: 'apply-agent',
        name: 'Different Name',
        description: 'second',
      }),
    });
    expect(second.status).toBe(200);
    const idempotent = (await second.json()) as any;
    expect(idempotent.agentId).toBe('apply-agent');
    expect(idempotent.name).toBe('Apply Agent');

    // No duplicate row in the agents table.
    const { getDb } = await import('../../db/client.js');
    const sql = getDb();
    const rows = await sql`SELECT id FROM agents WHERE id = 'apply-agent'`;
    expect(rows.length).toBe(1);
  });

  test('idempotent path does not re-inject the Owletto MCP server', async () => {
    const app = await importAgentRoutes();
    const { getDb } = await import('../../db/client.js');
    const sql = getDb();

    // Create the agent.
    const create = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'mcp-agent', name: 'MCP' }),
    });
    expect(create.status).toBe(201);

    // Operator has overridden mcpServers with a different value (e.g. via
    // `lobu apply` patching settings later). Simulate that by writing
    // directly to the column.
    await sql`
      UPDATE agents
      SET mcp_servers = ${sql.json({ owletto: { url: 'http://operator-set' } })},
          updated_at = NOW()
      WHERE id = 'mcp-agent'
    `;

    // Idempotent POST must NOT clobber the operator-set value.
    const second = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'mcp-agent', name: 'MCP' }),
    });
    expect(second.status).toBe(200);

    const rows = await sql`
      SELECT mcp_servers FROM agents WHERE id = 'mcp-agent'
    `;
    expect(rows[0].mcp_servers).toEqual({
      owletto: { url: 'http://operator-set' },
    });
  });

  test('cross-org collision still returns 409', async () => {
    const app = await importAgentRoutes();

    // Pre-seed an agent in org-b so the org-a POST collides cross-org.
    await seedAgent(ORG_B, 'shared-id');

    authStash.organizationId = ORG_A;
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'shared-id', name: 'Should Fail' }),
    });
    expect(response.status).toBe(409);
    const body = (await response.json()) as any;
    expect(body.error).toContain('another organization');
  });
});

describe('PUT /agents/:agentId/connections/by-stable-id/:stableId', () => {
  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrg(ORG_A);
    await seedAgent(ORG_A, 'host-agent');
    authStash.user = { id: 'u1', name: 'Test', email: 'u1@test', emailVerified: true };
    authStash.organizationId = ORG_A;
  });

  test('new stable ID creates a connection with that exact ID', async () => {
    const app = await importAgentRoutes();

    const response = await app.request(
      '/host-agent/connections/by-stable-id/host-agent-telegram-prod',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          platform: 'telegram',
          config: { botToken: 'tg-token-1' },
        }),
      }
    );
    expect(response.status).toBe(201);
    const body = (await response.json()) as any;
    expect(body.connection?.id).toBe('host-agent-telegram-prod');

    const { getDb } = await import('../../db/client.js');
    const sql = getDb();
    const rows = await sql`
      SELECT id, agent_id, platform
      FROM agent_connections
      WHERE id = 'host-agent-telegram-prod'
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].agent_id).toBe('host-agent');
    expect(rows[0].platform).toBe('telegram');
  });

  test('PUT with identical config returns { noop: true }', async () => {
    const app = await importAgentRoutes();
    const stableId = 'host-agent-telegram';

    // Use non-secret fields (no `*token*`/`*secret*` substring) so the
    // postgres-stores encryption layer doesn't transform values between
    // save and load. Secret-handling round-trip is exercised in the
    // chat-instance-manager path in production; this test pins the
    // route-layer noop logic.
    const config = { chatId: '12345', endpoint: 'https://example.com' };

    // First PUT creates.
    const create = await app.request(
      `/host-agent/connections/by-stable-id/${stableId}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'telegram', config }),
      }
    );
    expect(create.status).toBe(201);

    // Capture updated_at, then PUT identical config and assert it didn't move.
    const { getDb } = await import('../../db/client.js');
    const sql = getDb();
    const before = await sql`
      SELECT updated_at FROM agent_connections WHERE id = ${stableId}
    `;
    const beforeUpdatedAt = before[0].updated_at;

    // Tiny delay so a write would produce a different timestamp.
    await new Promise((r) => setTimeout(r, 10));

    const second = await app.request(
      `/host-agent/connections/by-stable-id/${stableId}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'telegram', config }),
      }
    );
    expect(second.status).toBe(200);
    const body = (await second.json()) as any;
    expect(body.noop).toBe(true);
    expect(body.connection?.id).toBe(stableId);

    const after = await sql`
      SELECT updated_at FROM agent_connections WHERE id = ${stableId}
    `;
    expect(after[0].updated_at?.getTime?.() ?? after[0].updated_at).toBe(
      beforeUpdatedAt?.getTime?.() ?? beforeUpdatedAt
    );
  });

  test('PUT with changed config returns { updated: true, willRestart: true }', async () => {
    const app = await importAgentRoutes();
    const stableId = 'host-agent-slack';

    // First create.
    await app.request(
      `/host-agent/connections/by-stable-id/${stableId}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          platform: 'slack',
          config: { chatId: 'C-OLD' },
        }),
      }
    );

    // Then PUT with a changed config (different value + new key).
    const response = await app.request(
      `/host-agent/connections/by-stable-id/${stableId}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          platform: 'slack',
          config: { chatId: 'C-NEW', workspaceId: 'T-NEW' },
        }),
      }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.updated).toBe(true);
    expect(body.willRestart).toBe(true);
    expect(body.connection?.id).toBe(stableId);
  });

  test('PUT against an unknown agent returns 404', async () => {
    const app = await importAgentRoutes();

    const response = await app.request(
      '/missing-agent/connections/by-stable-id/missing-agent-x-y',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'telegram', config: {} }),
      }
    );
    expect(response.status).toBe(404);
  });
});
