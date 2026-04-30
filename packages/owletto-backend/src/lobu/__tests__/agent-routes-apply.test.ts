/**
 * Tests covering the two `lobu apply`-friendly extensions to lobu/agent-routes.ts:
 *
 *   1. POST /agents — same-org duplicate returns 200 (idempotent), cross-org
 *      collision still 409, and the Owletto MCP auto-injection only runs on
 *      the create path (never on the idempotent return).
 *   2. PUT /agents/:agentId/platforms/by-stable-id/:stableId — caller-supplied
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
  // `authSource` mirrors the real middleware contract so admin-tier routes
  // gated by `requireSessionOrAdminPat` see a non-null value. Default to
  // 'session' — the existing apply tests simulate a web user.
  authSource: 'session' | 'pat' | 'oauth' | null;
  mcpAuthInfo: { scopes: string[] } | null;
} = {
  user: { id: 'u1', name: 'Test', email: 'u1@test', emailVerified: true },
  organizationId: 'org-a',
  authSource: 'session',
  mcpAuthInfo: null,
};

mock.module('../../auth/middleware', () => ({
  mcpAuth: async (c: any, next: any) => {
    c.set('user', authStash.user);
    c.set('organizationId', authStash.organizationId);
    c.set('authSource', authStash.authSource);
    c.set('mcpAuthInfo', authStash.mcpAuthInfo);
    return next();
  },
  // requireAuth is referenced elsewhere in the module — provide a passthrough
  // so importing files that destructure it still get a function.
  requireAuth: async (_c: any, next: any) => next(),
}));

// `getChatInstanceManager` returns whatever the active test installs into
// `chatManagerStash.manager` — null by default. The fallback (no-manager) path
// covers most of the route's correctness contract; tests that exercise the
// manager-side serialization (e.g. addConnection-call-count) install a stub
// here.
const chatManagerStash: { manager: unknown } = { manager: null };

mock.module('../gateway', () => ({
  getChatInstanceManager: () => chatManagerStash.manager,
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
    authStash.authSource = 'session';
    authStash.mcpAuthInfo = null;
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

describe('PUT /agents/:agentId/platforms/by-stable-id/:stableId', () => {
  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrg(ORG_A);
    await seedAgent(ORG_A, 'host-agent');
    authStash.user = { id: 'u1', name: 'Test', email: 'u1@test', emailVerified: true };
    authStash.organizationId = ORG_A;
    authStash.authSource = 'session';
    authStash.mcpAuthInfo = null;
  });

  test('new stable ID creates a platform with that exact ID', async () => {
    const app = await importAgentRoutes();

    const response = await app.request(
      '/host-agent/platforms/by-stable-id/host-agent-telegram-prod',
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
    expect(body.platform?.id).toBe('host-agent-telegram-prod');

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
      `/host-agent/platforms/by-stable-id/${stableId}`,
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
      `/host-agent/platforms/by-stable-id/${stableId}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'telegram', config }),
      }
    );
    expect(second.status).toBe(200);
    const body = (await second.json()) as any;
    expect(body.noop).toBe(true);
    expect(body.platform?.id).toBe(stableId);

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
      `/host-agent/platforms/by-stable-id/${stableId}`,
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
      `/host-agent/platforms/by-stable-id/${stableId}`,
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
    expect(body.platform?.id).toBe(stableId);
  });

  test('PUT with settings-only change returns updated + willRestart', async () => {
    const app = await importAgentRoutes();
    const stableId = 'host-agent-tg-settings';

    // First create with default settings.
    const create = await app.request(
      `/host-agent/platforms/by-stable-id/${stableId}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          platform: 'telegram',
          config: { chatId: 'C-1' },
        }),
      }
    );
    expect(create.status).toBe(201);

    // Same config, but settings change (allowFrom from undefined to ['user-1']).
    const response = await app.request(
      `/host-agent/platforms/by-stable-id/${stableId}`,
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          platform: 'telegram',
          config: { chatId: 'C-1' },
          settings: { allowFrom: ['user-1'], allowGroups: true },
        }),
      }
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as any;
    expect(body.updated).toBe(true);
    expect(body.willRestart).toBe(true);
    expect(body.noop).toBeUndefined();
  });

  test('PUT against an unknown agent returns 404', async () => {
    const app = await importAgentRoutes();

    const response = await app.request(
      '/missing-agent/platforms/by-stable-id/missing-agent-x-y',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'telegram', config: {} }),
      }
    );
    expect(response.status).toBe(404);
  });
});

describe('platform ownership checks', () => {
  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrg(ORG_A);
    await seedAgent(ORG_A, 'owner-agent');
    await seedAgent(ORG_A, 'other-agent');
    authStash.user = { id: 'u1', name: 'Test', email: 'u1@test', emailVerified: true };
    authStash.organizationId = ORG_A;
    authStash.authSource = 'session';
    authStash.mcpAuthInfo = null;
    chatManagerStash.manager = null;
  });

  test('GET /:agentId/platforms/:platformId rejects platforms bound to another agent', async () => {
    const app = await importAgentRoutes();
    const create = await app.request('/owner-agent/platforms/by-stable-id/owner-agent-slack', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'slack', config: { botToken: 'xoxb-test' } }),
    });
    expect(create.status).toBe(201);

    const leaked = await app.request('/other-agent/platforms/owner-agent-slack');
    expect(leaked.status).toBe(404);

    const allowed = await app.request('/owner-agent/platforms/owner-agent-slack');
    expect(allowed.status).toBe(200);
  });

  test('start/stop reject platforms bound to another agent', async () => {
    const app = await importAgentRoutes();
    const create = await app.request('/owner-agent/platforms/by-stable-id/owner-agent-telegram', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ platform: 'telegram', config: { botToken: 'tg-test' } }),
    });
    expect(create.status).toBe(201);

    const start = await app.request('/other-agent/platforms/owner-agent-telegram/start', {
      method: 'POST',
    });
    expect(start.status).toBe(404);

    const stop = await app.request('/other-agent/platforms/owner-agent-telegram/stop', {
      method: 'POST',
    });
    expect(stop.status).toBe(404);
  });
});

describe('concurrent-apply race fixes', () => {
  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrg(ORG_A);
    authStash.user = { id: 'u1', name: 'Test', email: 'u1@test', emailVerified: true };
    authStash.organizationId = ORG_A;
    authStash.authSource = 'session';
    authStash.mcpAuthInfo = null;
  });

  test('POST /agents — two concurrent creates resolve to one 201 + one 200, single row', async () => {
    const app = await importAgentRoutes();

    const payload = JSON.stringify({
      agentId: 'race-agent',
      name: 'Race Agent',
      description: 'concurrent',
    });

    // Both requests fire before either response — exercises the
    // ON CONFLICT (id) DO NOTHING claim path.
    const [r1, r2] = await Promise.all([
      app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      }),
      app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: payload,
      }),
    ]);

    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 201]);

    const { getDb } = await import('../../db/client.js');
    const sql = getDb();

    // Exactly one row.
    const rows = await sql`SELECT id FROM agents WHERE id = 'race-agent'`;
    expect(rows.length).toBe(1);

    // The auto-injected MCP server is exactly one entry — not double-written
    // by both handlers (which would have left the same value but proved both
    // ran the saveSettings path).
    const settings = await sql`
      SELECT mcp_servers FROM agents WHERE id = 'race-agent'
    `;
    expect(settings[0].mcp_servers).toEqual({
      owletto: { url: expect.stringContaining('/mcp/') },
    });
  });

  test('POST /agents — concurrent create cannot overwrite operator-set MCP servers', async () => {
    const app = await importAgentRoutes();
    const { getDb } = await import('../../db/client.js');
    const sql = getDb();

    // First, do a normal create so the row + initial MCP server exist.
    const initial = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'preserved-agent', name: 'Preserved' }),
    });
    expect(initial.status).toBe(201);

    // Operator overrides mcp_servers (e.g. via a subsequent PATCH /config).
    await sql`
      UPDATE agents
      SET mcp_servers = ${sql.json({ owletto: { url: 'http://operator-set' } })},
          updated_at = NOW()
      WHERE id = 'preserved-agent'
    `;

    // Two concurrent re-applies must both take the idempotent path; neither
    // should re-run the MCP auto-injection.
    const [r1, r2] = await Promise.all([
      app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'preserved-agent', name: 'Preserved' }),
      }),
      app.request('/', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId: 'preserved-agent', name: 'Preserved' }),
      }),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const after = await sql`
      SELECT mcp_servers FROM agents WHERE id = 'preserved-agent'
    `;
    expect(after[0].mcp_servers).toEqual({
      owletto: { url: 'http://operator-set' },
    });
  });

  test('PUT /platforms/by-stable-id — two concurrent identical PUTs converge to one row', async () => {
    const app = await importAgentRoutes();
    await seedAgent(ORG_A, 'race-host');

    const stableId = 'race-host-telegram-prod';
    const config = { chatId: '12345', endpoint: 'https://example.com' };

    const [r1, r2] = await Promise.all([
      app.request(`/race-host/platforms/by-stable-id/${stableId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'telegram', config }),
      }),
      app.request(`/race-host/platforms/by-stable-id/${stableId}`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'telegram', config }),
      }),
    ]);

    expect([r1.status, r2.status].sort()).toEqual([200, 201]);

    const bodies = [(await r1.json()) as any, (await r2.json()) as any];
    const created = bodies.find((b) => b.platform && !b.noop && !b.updated);
    expect(created).toBeTruthy();
    expect(created?.platform?.id).toBe(stableId);

    // The other response must be either noop:true (config unchanged) or
    // updated:true (the loser observed the placeholder/empty config first
    // and went down the update path). Both are correct per the race-fix
    // contract: the row is consistent and we did not double-spawn.
    const other = bodies.find((b) => b !== created);
    expect(other?.noop === true || other?.updated === true).toBe(true);

    const { getDb } = await import('../../db/client.js');
    const sql = getDb();
    const rows = await sql`
      SELECT id, agent_id, platform FROM agent_connections WHERE id = ${stableId}
    `;
    expect(rows.length).toBe(1);
    expect(rows[0].agent_id).toBe('race-host');
    expect(rows[0].platform).toBe('telegram');
  });
});

describe('admin-tier auth admission (requireSessionOrAdminPat)', () => {
  // Pi-flagged in #468: PAT/OAuth bearers now hydrate `c.var.user`, so admin
  // routes that previously implicitly required a web session were exposed to
  // any PAT. The helper requires either a better-auth session, or a PAT/OAuth
  // token with mcp:admin scope.

  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrg(ORG_A);
    authStash.user = { id: 'u1', name: 'Test', email: 'u1@test', emailVerified: true };
    authStash.organizationId = ORG_A;
    authStash.authSource = 'session';
    authStash.mcpAuthInfo = null;
  });

  test('POST /agents accepts a session caller', async () => {
    const app = await importAgentRoutes();
    authStash.authSource = 'session';
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'session-agent', name: 'Session' }),
    });
    expect(response.status).toBe(201);
  });

  test('POST /agents accepts a PAT with mcp:admin scope', async () => {
    const app = await importAgentRoutes();
    authStash.authSource = 'pat';
    authStash.mcpAuthInfo = { scopes: ['mcp:read', 'mcp:write', 'mcp:admin'] };
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'admin-pat-agent', name: 'Admin PAT' }),
    });
    expect(response.status).toBe(201);
  });

  test('POST /agents rejects a PAT that lacks mcp:admin scope', async () => {
    const app = await importAgentRoutes();
    authStash.authSource = 'pat';
    authStash.mcpAuthInfo = { scopes: ['mcp:read'] };
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'weak-pat-agent', name: 'Weak PAT' }),
    });
    expect(response.status).toBe(403);
    const body = (await response.json()) as any;
    expect(body.error).toBe('forbidden');
    expect(body.error_description).toContain('mcp:admin');

    // No row should have been created.
    const { getDb } = await import('../../db/client.js');
    const sql = getDb();
    const rows = await sql`SELECT id FROM agents WHERE id = 'weak-pat-agent'`;
    expect(rows.length).toBe(0);
  });

  test('POST /agents rejects a write-scoped PAT (no mcp:admin)', async () => {
    const app = await importAgentRoutes();
    authStash.authSource = 'pat';
    authStash.mcpAuthInfo = { scopes: ['mcp:read', 'mcp:write'] };
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'write-pat-agent', name: 'Write PAT' }),
    });
    expect(response.status).toBe(403);
  });

  test('POST /agents rejects an OAuth bearer that lacks mcp:admin scope', async () => {
    const app = await importAgentRoutes();
    authStash.authSource = 'oauth';
    authStash.mcpAuthInfo = { scopes: ['mcp:read', 'mcp:write'] };
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'weak-oauth-agent', name: 'Weak OAuth' }),
    });
    expect(response.status).toBe(403);
  });

  test('POST /agents rejects an anonymous caller (authSource null)', async () => {
    const app = await importAgentRoutes();
    authStash.authSource = null;
    authStash.mcpAuthInfo = null;
    const response = await app.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId: 'anon-agent', name: 'Anon' }),
    });
    expect(response.status).toBe(401);
  });

  test('PATCH /:agentId rejects a read-only PAT', async () => {
    const app = await importAgentRoutes();
    await seedAgent(ORG_A, 'patch-target');
    authStash.authSource = 'pat';
    authStash.mcpAuthInfo = { scopes: ['mcp:read'] };
    const response = await app.request('/patch-target', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Should Not Change' }),
    });
    expect(response.status).toBe(403);
  });

  test('DELETE /:agentId rejects a read-only PAT', async () => {
    const app = await importAgentRoutes();
    await seedAgent(ORG_A, 'delete-target');
    authStash.authSource = 'pat';
    authStash.mcpAuthInfo = { scopes: ['mcp:read'] };
    const response = await app.request('/delete-target', {
      method: 'DELETE',
    });
    expect(response.status).toBe(403);

    const { getDb } = await import('../../db/client.js');
    const sql = getDb();
    const rows = await sql`SELECT id FROM agents WHERE id = 'delete-target'`;
    expect(rows.length).toBe(1);
  });

  test('PUT /:agentId/platforms/by-stable-id rejects a write-only PAT', async () => {
    const app = await importAgentRoutes();
    await seedAgent(ORG_A, 'conn-host');
    authStash.authSource = 'pat';
    authStash.mcpAuthInfo = { scopes: ['mcp:read', 'mcp:write'] };
    const response = await app.request(
      '/conn-host/platforms/by-stable-id/conn-host-tg',
      {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ platform: 'telegram', config: { chatId: '1' } }),
      }
    );
    expect(response.status).toBe(403);
  });

  test('POST /:agentId/platforms/:platformId/start rejects a write-only PAT', async () => {
    const app = await importAgentRoutes();
    await seedAgent(ORG_A, 'lifecycle-host-start');
    authStash.authSource = 'pat';
    authStash.mcpAuthInfo = { scopes: ['mcp:read', 'mcp:write'] };
    const response = await app.request(
      '/lifecycle-host-start/platforms/some-platform-id/start',
      { method: 'POST' }
    );
    expect(response.status).toBe(403);
  });

  test('POST /:agentId/platforms/:platformId/stop rejects a write-only PAT', async () => {
    const app = await importAgentRoutes();
    await seedAgent(ORG_A, 'lifecycle-host-stop');
    authStash.authSource = 'pat';
    authStash.mcpAuthInfo = { scopes: ['mcp:read', 'mcp:write'] };
    const response = await app.request(
      '/lifecycle-host-stop/platforms/some-platform-id/stop',
      { method: 'POST' }
    );
    expect(response.status).toBe(403);
  });
});

describe('residual-race fixes (PR-466 follow-up)', () => {
  beforeEach(async () => {
    await resetTestDatabase();
    await seedOrg(ORG_A);
    authStash.user = { id: 'u1', name: 'Test', email: 'u1@test', emailVerified: true };
    authStash.organizationId = ORG_A;
    authStash.authSource = 'session';
    authStash.mcpAuthInfo = null;
    chatManagerStash.manager = null;
  });

  test(
    'POST /agents — concurrent creates always leave mcpServers populated (20 iterations)',
    async () => {
      // The pre-fix flow split row creation and the auto-injected `mcpServers`
      // into two writes (INSERT, then `saveSettings`). A concurrent loser
      // returning 200 in the idempotent branch could observe the row before
      // the winner's `saveSettings` landed and clobber `mcpServers` via a
      // PATCH that races with the deferred winner write. Folding the column
      // into the INSERT makes the loser see fully-initialized state on its
      // first read.
      const app = await importAgentRoutes();
      const { getDb } = await import('../../db/client.js');
      const sql = getDb();

      for (let i = 0; i < 20; i++) {
        const agentId = `race-mcp-${i}`;
        const payload = JSON.stringify({
          agentId,
          name: `Race MCP ${i}`,
        });

        const [r1, r2] = await Promise.all([
          app.request('/', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: payload,
          }),
          app.request('/', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: payload,
          }),
        ]);

        const statuses = [r1.status, r2.status].sort();
        expect(statuses).toEqual([200, 201]);

        // The agent row exists exactly once and `mcp_servers.owletto.url` is
        // populated regardless of which request handler ran the INSERT and
        // which observed it via the idempotent branch.
        const rows = await sql`
          SELECT id, mcp_servers FROM agents WHERE id = ${agentId}
        `;
        expect(rows.length).toBe(1);
        const mcpServers = rows[0].mcp_servers as
          | { owletto?: { url?: string } }
          | undefined;
        expect(mcpServers?.owletto?.url).toBeTruthy();
        expect(mcpServers?.owletto?.url).toContain('/mcp/');
      }
    }
  );

  test(
    'PUT /platforms/by-stable-id — concurrent PUTs invoke addConnection exactly once',
    async () => {
      // Without the in-process per-stableId chain (and the diagnostic
      // pg_advisory_xact_lock backing it), a concurrent loser can re-read
      // the just-created row mid-`addConnection` and call
      // `updateConnection` against half-initialized state — potentially
      // double-spawning the chat instance. The chain serializes the
      // create-or-update flow on the stable ID; only the winner reaches
      // `addConnection`, every other writer sees committed state and goes
      // to the update path.
      const app = await importAgentRoutes();
      await seedAgent(ORG_A, 'mgr-host');

      const calls: { addConnection: number; updateConnection: number } = {
        addConnection: 0,
        updateConnection: 0,
      };

      // Mock manager: addConnection takes a few microseconds (small Promise
      // tick) so the second PUT has time to enqueue at the lock before the
      // first PUT releases it. The lock fix is what guarantees the second
      // PUT then sees a committed row.
      chatManagerStash.manager = {
        async addConnection(
          platform: string,
          templateAgentId: string,
          config: Record<string, unknown>,
          settings: Record<string, unknown>,
          metadata: Record<string, unknown>,
          stableId: string
        ) {
          calls.addConnection++;
          // Yield to the event loop a few times so the loser actually runs
          // its lock-acquire while we hold ours.
          for (let i = 0; i < 5; i++) {
            await new Promise((r) => setTimeout(r, 0));
          }
          return {
            id: stableId,
            platform,
            templateAgentId,
            config,
            settings,
            metadata,
            status: 'active' as const,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          };
        },
        async updateConnection(stableId: string, updates: Record<string, unknown>) {
          calls.updateConnection++;
          // Read the existing row through the connection store so the test
          // mirrors the production manager behavior closely enough that the
          // route's persistConnectionSnapshot call sees a sane shape.
          const { getDb } = await import('../../db/client.js');
          const sql = getDb();
          const rows = await sql`
            SELECT * FROM agent_connections WHERE id = ${stableId}
          `;
          const row = rows[0] ?? {};
          const updatedConfig =
            ((updates as { config?: Record<string, unknown> }).config ??
              row.config) ?? {};
          const updatedSettings =
            ((updates as { settings?: Record<string, unknown> }).settings ??
              row.settings) ?? {};
          return {
            id: stableId,
            platform: row.platform ?? 'telegram',
            templateAgentId: row.agent_id ?? 'mgr-host',
            config: updatedConfig,
            settings: updatedSettings,
            metadata: row.metadata ?? {},
            status: 'active' as const,
            createdAt:
              row.created_at instanceof Date
                ? row.created_at.getTime()
                : (row.created_at ?? Date.now()),
            updatedAt: Date.now(),
          };
        },
      };

      const stableId = 'mgr-host-telegram-prod';
      const config = { chatId: '12345', endpoint: 'https://example.com' };

      const [r1, r2] = await Promise.all([
        app.request(`/mgr-host/platforms/by-stable-id/${stableId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ platform: 'telegram', config }),
        }),
        app.request(`/mgr-host/platforms/by-stable-id/${stableId}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ platform: 'telegram', config }),
        }),
      ]);

      // Exactly one PUT created (201); the loser is either a noop (200) or
      // an update (200), never another create.
      expect([r1.status, r2.status].sort()).toEqual([200, 201]);

      // The race-fix contract: only ONE addConnection call hit the manager.
      // Without the in-process chain, both PUTs could observe `existing===null`
      // and both call addConnection.
      expect(calls.addConnection).toBe(1);

      const { getDb } = await import('../../db/client.js');
      const sql = getDb();
      const rows = await sql`
        SELECT id FROM agent_connections WHERE id = ${stableId}
      `;
      expect(rows.length).toBe(1);
    }
  );
});
