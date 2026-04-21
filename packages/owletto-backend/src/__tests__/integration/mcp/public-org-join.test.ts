import { beforeAll, describe, expect, it } from 'vitest';
import { getTestDb, cleanupTestDatabase } from '../../setup/test-db';
import {
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestSession,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { get, post } from '../../setup/test-helpers';

describe('Public org read access + self-serve join', () => {
  let publicOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let privateOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let outsiderUser: Awaited<ReturnType<typeof createTestUser>>;
  let outsiderSessionCookie: string;
  let client: Awaited<ReturnType<typeof createTestOAuthClient>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    publicOrg = await createTestOrganization({
      name: 'Public Join Org',
      slug: 'public-join-org',
      description: 'Anyone can read',
      visibility: 'public',
    });
    privateOrg = await createTestOrganization({
      name: 'Private Join Org',
      slug: 'private-join-org',
      visibility: 'private',
    });
    outsiderUser = await createTestUser({ email: 'outsider@test.example.com' });
    outsiderSessionCookie = (await createTestSession(outsiderUser.id)).cookieHeader;
    client = await createTestOAuthClient();
  });

  async function initializeScopedSession(path: string, token: string) {
    const initResponse = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: '__test_init__',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'owletto-test', version: '1.0' },
        },
      },
      token,
    });
    const sessionId = initResponse.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    await post(path, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      headers: { 'mcp-session-id': sessionId! },
      token,
    });
    return sessionId!;
  }

  // (a) non-member reads on public org succeed via public/* routes
  describe('public/* REST endpoints', () => {
    it('returns sanitized organization metadata to anonymous callers', async () => {
      const response = await get(`/api/${publicOrg.slug}/public/organization`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.organization.slug).toBe(publicOrg.slug);
      expect(body.organization.name).toBe(publicOrg.name);
      expect(body.organization.visibility).toBe('public');
      expect(body.organization).toHaveProperty('agent_count');
      expect(body.organization).toHaveProperty('entity_type_count');
      expect(body.organization).not.toHaveProperty('members');
    });

    it('returns agent list without credentials to anonymous callers', async () => {
      const response = await get(`/api/${publicOrg.slug}/public/agents`);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(Array.isArray(body.agents)).toBe(true);
      for (const agent of body.agents) {
        expect(agent).not.toHaveProperty('auth_profile_id');
        expect(agent).not.toHaveProperty('mcp_servers');
        expect(agent).not.toHaveProperty('config');
      }
    });

    it('404s when the org is private (no leak of existence)', async () => {
      const response = await get(`/api/${privateOrg.slug}/public/organization`);
      expect(response.status).toBe(404);
    });
  });

  // (b) self-serve join inserts member + (d) duplicate join idempotent
  describe('POST /api/:orgSlug/join', () => {
    it('requires an authenticated session', async () => {
      const response = await post(`/api/${publicOrg.slug}/join`, { body: {} });
      expect(response.status).toBe(401);
    });

    it('inserts a member row with role=member and is idempotent on re-call', async () => {
      const firstResponse = await post(`/api/${publicOrg.slug}/join`, {
        body: {},
        cookie: outsiderSessionCookie,
      });
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json();
      expect(first.status).toBe('joined');
      expect(first.role).toBe('member');
      expect(first.organizationId).toBe(publicOrg.id);

      const sql = getTestDb();
      const rows = await sql`
        SELECT role FROM "member"
        WHERE "organizationId" = ${publicOrg.id} AND "userId" = ${outsiderUser.id}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0].role).toBe('member');

      // (d) duplicate join returns already_member without inserting a second row
      const secondResponse = await post(`/api/${publicOrg.slug}/join`, {
        body: {},
        cookie: outsiderSessionCookie,
      });
      expect(secondResponse.status).toBe(200);
      const second = await secondResponse.json();
      expect(second.status).toBe('already_member');
      expect(second.role).toBe('member');

      const rowsAfter = await sql`
        SELECT id FROM "member"
        WHERE "organizationId" = ${publicOrg.id} AND "userId" = ${outsiderUser.id}
      `;
      expect(rowsAfter).toHaveLength(1);
    });

    // (c) join on private org 403s
    it('403s when the workspace is private', async () => {
      const otherUser = await createTestUser({ email: 'private-joiner@test.example.com' });
      const cookie = (await createTestSession(otherUser.id)).cookieHeader;
      const response = await post(`/api/${privateOrg.slug}/join`, {
        body: {},
        cookie,
      });
      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('forbidden');
    });

    it('404s for an unknown slug', async () => {
      const response = await post('/api/does-not-exist-xyz/join', {
        body: {},
        cookie: outsiderSessionCookie,
      });
      expect(response.status).toBe(404);
    });
  });

  // (e) MCP write tool on public org (non-member) returns new error message
  describe('MCP write denial surfaces join_organization', () => {
    it('surfaces a join_organization hint when a non-member tries to write', async () => {
      const user = await createTestUser({ email: 'mcp-nonmember@test.example.com' });
      const { token } = await createTestAccessToken(user.id, publicOrg.id, client.client_id, {
        scope: 'mcp:write profile:read',
      });
      const sessionId = await initializeScopedSession(`/mcp/${publicOrg.slug}`, token);

      const response = await post(`/mcp/${publicOrg.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'save_knowledge',
            arguments: {
              content: 'non-member should be denied with join hint',
              semantic_type: 'content',
              metadata: {},
            },
          },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.result?.isError).toBe(true);
      const text = body.result?.content?.[0]?.text ?? '';
      expect(text).toContain('join_organization');
    });
  });

  // (f) join_organization flips subsequent write from denied to allowed
  describe('MCP join_organization tool', () => {
    it('upgrades a writeable session so a subsequent entity create succeeds', async () => {
      const user = await createTestUser({ email: 'mcp-joiner@test.example.com' });
      const { token } = await createTestAccessToken(user.id, publicOrg.id, client.client_id, {
        scope: 'mcp:write profile:read',
      });
      const sessionId = await initializeScopedSession(`/mcp/${publicOrg.slug}`, token);

      // Before join: manage_entity:create must be denied (non-member).
      const beforeResponse = await post(`/mcp/${publicOrg.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'manage_entity',
            arguments: {
              action: 'create',
              name: 'Pre-join Entity',
              entity_type: 'brand',
            },
          },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });
      const beforeBody = await beforeResponse.json();
      expect(beforeBody.result?.isError).toBe(true);
      expect(beforeBody.result?.content?.[0]?.text ?? '').toContain('join_organization');

      // Join via MCP tool
      const joinResponse = await post(`/mcp/${publicOrg.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: { name: 'join_organization', arguments: {} },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });
      const joinBody = await joinResponse.json();
      expect(joinBody.result?.isError).not.toBe(true);
      const joinText = joinBody.result?.content?.[0]?.text ?? '';
      const parsed = JSON.parse(joinText);
      expect(parsed.status === 'joined' || parsed.status === 'already_member').toBe(true);
      expect(parsed.org.role).toBe('member');
      // Write-scoped session shouldn't receive the read-only note
      expect(parsed.note).toBeUndefined();

      // After join: manage_entity:create must succeed.
      const afterResponse = await post(`/mcp/${publicOrg.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: {
            name: 'manage_entity',
            arguments: {
              action: 'create',
              name: 'Post-join Entity',
              entity_type: 'brand',
            },
          },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });
      const afterBody = await afterResponse.json();
      expect(afterBody.result?.isError).not.toBe(true);
    });

    it('returns a read-only scope note when the session cannot write', async () => {
      const user = await createTestUser({ email: 'mcp-readonly-joiner@test.example.com' });
      const { token } = await createTestAccessToken(user.id, publicOrg.id, client.client_id, {
        scope: 'mcp:read profile:read',
      });
      const sessionId = await initializeScopedSession(`/mcp/${publicOrg.slug}`, token);

      const joinResponse = await post(`/mcp/${publicOrg.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'join_organization', arguments: {} },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });
      const joinBody = await joinResponse.json();
      expect(joinBody.result?.isError).not.toBe(true);
      const text = joinBody.result?.content?.[0]?.text ?? '';
      const parsed = JSON.parse(text);
      expect(parsed.note).toBeDefined();
      expect(parsed.note).toContain('mcp:write');
    });

    it('rejects join_organization when the token has no mcp:* scope', async () => {
      const user = await createTestUser({ email: 'mcp-noscope-joiner@test.example.com' });
      const { token } = await createTestAccessToken(user.id, publicOrg.id, client.client_id, {
        scope: 'profile:read',
      });
      const sessionId = await initializeScopedSession(`/mcp/${publicOrg.slug}`, token);

      const joinResponse = await post(`/mcp/${publicOrg.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'join_organization', arguments: {} },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });
      const joinBody = await joinResponse.json();
      expect(joinBody.result?.isError).toBe(true);
      expect(joinBody.result?.content?.[0]?.text ?? '').toContain('mcp:');
    });

    it('rejects joining a private workspace via MCP tool', async () => {
      const user = await createTestUser({ email: 'mcp-private-joiner@test.example.com' });
      const { token } = await createTestAccessToken(user.id, privateOrg.id, client.client_id, {
        scope: 'mcp:write profile:read',
      });
      const sessionId = await initializeScopedSession(`/mcp/${privateOrg.slug}`, token);

      const joinResponse = await post(`/mcp/${privateOrg.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'join_organization', arguments: {} },
        },
        headers: { 'mcp-session-id': sessionId },
        token,
      });
      const joinBody = await joinResponse.json();
      expect(joinBody.result?.isError).toBe(true);
      expect(joinBody.result?.content?.[0]?.text ?? '').toContain('not public');
    });
  });
});
