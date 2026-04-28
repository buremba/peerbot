import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestSession,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { post } from '../../setup/test-helpers';

describe('MCP member write access', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let publicOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let owner: Awaited<ReturnType<typeof createTestUser>>;
  let client: Awaited<ReturnType<typeof createTestOAuthClient>>;
  let ownerSessionCookie: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Member Write Org', slug: 'member-write-org' });
    publicOrg = await createTestOrganization({
      name: 'Public Read Org',
      slug: 'public-read-org',
      visibility: 'public',
    });
    user = await createTestUser({ email: 'member-write@test.example.com' });
    owner = await createTestUser({ email: 'owner-write@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'member');
    await addUserToOrganization(owner.id, org.id, 'owner');
    client = await createTestOAuthClient();
    ownerSessionCookie = (await createTestSession(owner.id)).cookieHeader;
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
      body: {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      },
      headers: { 'mcp-session-id': sessionId! },
      token,
    });

    return sessionId!;
  }

  it('allows a regular member with write scope to save knowledge', async () => {
    const { token } = await createTestAccessToken(user.id, org.id, client.client_id, {
      scope: 'mcp:write profile:read',
    });
    const sessionId = await initializeScopedSession(`/mcp/${org.slug}`, token);

    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'save_knowledge',
          arguments: {
            content: 'member write access test',
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
    expect(body.result?.isError).not.toBe(true);
  });

  it('hides save_knowledge for a member token that only has read scope', async () => {
    const { token } = await createTestAccessToken(user.id, org.id, client.client_id, {
      scope: 'mcp:read profile:read',
    });
    const sessionId = await initializeScopedSession(`/mcp/${org.slug}`, token);

    const response = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    const toolNames = body.result.tools.map((tool: any) => tool.name);

    expect(toolNames).not.toContain('save_knowledge');
    // manage_entity moved to the internal REST/CLI surface in #432; it's no
    // longer registered as an external MCP tool. Verify that read-only
    // discovery surfaces (search_knowledge / search) are still visible.
    expect(toolNames).toContain('search_knowledge');
    expect(toolNames).toContain('search');
  });

  it('returns an upgrade-path message for public-org non-member write attempts', async () => {
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
            content: 'public org should reject write',
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
    expect(body.result?.content?.[0]?.text).toContain(
      'This public workspace is read-only for your account'
    );
  });

  it('applies role downgrades immediately to existing MCP sessions', async () => {
    const adminUser = await createTestUser({ email: 'downgrade-member@test.example.com' });
    const adminMemberId = await addUserToOrganization(adminUser.id, org.id, 'admin');
    const { token } = await createTestAccessToken(adminUser.id, org.id, client.client_id, {
      scope: 'mcp:admin profile:read',
    });
    const sessionId = await initializeScopedSession(`/mcp/${org.slug}`, token);

    const beforeResponse = await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const beforeBody = await beforeResponse.json();
    const beforeNames = beforeBody.result.tools.map((tool: any) => tool.name);
    // Admin/owner sessions see `query_sql` (admin-tier read).
    expect(beforeNames).toContain('query_sql');
    expect(beforeNames).toContain('run');

    const downgradeResponse = await post('/api/auth/organization/update-member-role', {
      body: {
        memberId: adminMemberId,
        role: 'member',
        organizationId: org.id,
      },
      cookie: ownerSessionCookie,
    });
    expect(downgradeResponse.status).toBe(200);

    const afterResponse = await post(`/mcp/${org.slug}`, {
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    const afterBody = await afterResponse.json();
    const afterTools = afterBody.result.tools.map((tool: any) => tool.name);
    expect(afterTools).toContain('save_knowledge');
    // Member tier loses admin-only `query_sql`.
    expect(afterTools).not.toContain('query_sql');
  });

  it('applies member removal immediately to existing MCP sessions', async () => {
    const removableUser = await createTestUser({ email: 'remove-member@test.example.com' });
    const removableMemberId = await addUserToOrganization(removableUser.id, org.id, 'member');
    const { token } = await createTestAccessToken(removableUser.id, org.id, client.client_id, {
      scope: 'mcp:write profile:read',
    });
    const sessionId = await initializeScopedSession(`/mcp/${org.slug}`, token);

    const beforeResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'save_knowledge',
          arguments: {
            content: 'before removal still works',
            semantic_type: 'content',
            metadata: {},
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    expect(beforeResponse.status).toBe(200);
    const beforeBody = await beforeResponse.json();
    expect(beforeBody.result?.isError).not.toBe(true);

    const removeResponse = await post('/api/auth/organization/remove-member', {
      body: {
        memberIdOrEmail: removableMemberId,
        organizationId: org.id,
      },
      cookie: ownerSessionCookie,
    });
    expect(removeResponse.status).toBe(200);

    const afterResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: 'save_knowledge',
          arguments: {
            content: 'after removal should fail',
            semantic_type: 'content',
            metadata: {},
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    expect(afterResponse.status).toBe(403);
    const afterBody = await afterResponse.json();
    expect(afterBody.error).toBe('forbidden');
    expect(afterBody.error_description).toContain(
      'Token owner is not a member of this organization'
    );
  });

  it('applies self-leave immediately to token-based MCP access', async () => {
    const leaverUser = await createTestUser({ email: 'leave-member@test.example.com' });
    await addUserToOrganization(leaverUser.id, org.id, 'member');
    const leaverSessionCookie = (await createTestSession(leaverUser.id)).cookieHeader;
    const { token } = await createTestAccessToken(leaverUser.id, org.id, client.client_id, {
      scope: 'mcp:write profile:read',
    });
    const sessionId = await initializeScopedSession(`/mcp/${org.slug}`, token);

    const leaveResponse = await post('/api/auth/organization/leave', {
      body: { organizationId: org.id },
      cookie: leaverSessionCookie,
    });
    expect(leaveResponse.status).toBe(200);

    const afterResponse = await post(`/mcp/${org.slug}`, {
      body: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'save_knowledge',
          arguments: {
            content: 'after leave should fail',
            semantic_type: 'content',
            metadata: {},
          },
        },
      },
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    expect(afterResponse.status).toBe(403);
    const afterBody = await afterResponse.json();
    expect(afterBody.error).toBe('forbidden');
  });
});
