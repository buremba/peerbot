/**
 * MCP Authentication Tests
 *
 * Tests for MCP endpoint authentication including:
 * - OAuth access tokens
 * - Personal Access Tokens (PATs)
 * - Unauthenticated discovery requests
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { clearInMemoryMcpSessionsForTests } from '../../../mcp-handler';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createExpiredAccessToken,
  createTestAccessToken,
  createTestAgent,
  createTestDeviceCode,
  createTestEntity,
  createTestOAuthClient,
  createTestOrganization,
  createTestPAT,
  createTestSession,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { del, get, mcpListTools, mcpRequest, mcpToolsCall, post } from '../../setup/test-helpers';

describe('MCP Authentication', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let publicOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let org2: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let client: Awaited<ReturnType<typeof createTestOAuthClient>>;
  let agent: Awaited<ReturnType<typeof createTestAgent>>;
  let publicEntity: Awaited<ReturnType<typeof createTestEntity>>;
  let sessionCookie: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Test Org' });
    publicOrg = await createTestOrganization({ name: 'Public Org', visibility: 'public' });
    org2 = await createTestOrganization({ name: 'Second Org' });
    user = await createTestUser({});
    await addUserToOrganization(user.id, org.id);
    await addUserToOrganization(user.id, org2.id);
    client = await createTestOAuthClient();
    agent = await createTestAgent({
      organizationId: org.id,
      agentId: 'owletto-test-agent',
      ownerUserId: user.id,
    });
    publicEntity = await createTestEntity({
      name: 'Public Brand',
      organization_id: publicOrg.id,
      entity_type: 'brand',
    });
    const session = await createTestSession(user.id);
    sessionCookie = session.cookieHeader;
  });

  describe('Unauthenticated Requests', () => {
    it('allows unauthenticated tools/list discovery requests including list_organizations', async () => {
      const response = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.error).toBeUndefined();
      expect(body.result.tools).toBeInstanceOf(Array);
      expect(body.result.tools.length).toBeGreaterThan(0);
      const toolNames = body.result.tools.map((t: any) => t.name);
      expect(toolNames).toContain('list_organizations');
      expect(toolNames).not.toContain('switch_organization');
    });

    it('returns an OAuth challenge for anonymous root session stream requests', async () => {
      const initResponse = await post('/mcp', {
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
      });

      const sessionId = initResponse.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      const response = await get('/mcp', {
        headers: {
          Accept: 'text/event-stream',
          'mcp-session-id': sessionId!,
        },
      });

      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toContain(
        '/.well-known/oauth-protected-resource'
      );
    });

    it('upgrades an anonymous unscoped session when Bearer token is provided', async () => {
      const initResponse = await post('/mcp', {
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
      });

      const sessionId = initResponse.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      // Anonymous tool call should be rejected
      const anonResponse = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'search_knowledge',
            arguments: { query: 'upgrade-test-probe' },
          },
        },
        headers: { 'mcp-session-id': sessionId! },
      });
      expect(anonResponse.status).toBe(401);

      // Re-initialize with a new anonymous session (previous was cleared)
      const initResponse2 = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: '__test_init_2__',
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: { name: 'owletto-test', version: '1.0' },
          },
        },
      });
      const sessionId2 = initResponse2.headers.get('mcp-session-id');
      expect(sessionId2).toBeTruthy();

      // Now provide a Bearer token on the same session — should upgrade auth
      const { token } = await createTestAccessToken(user.id, org.id, client.client_id);
      const authResponse = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'search_knowledge',
            arguments: { query: 'upgrade-test-probe-after-auth' },
          },
        },
        headers: { 'mcp-session-id': sessionId2! },
        token,
      });
      expect(authResponse.status).toBe(200);
      const body = await authResponse.json();
      expect(body.error).toBeUndefined();
      expect(body.result).toBeDefined();
    });

    it('rejects anonymous public-readable tool calls for private workspaces', async () => {
      const response = await post(`/api/${org.slug}/resolve_path`, {
        body: {
          path: `/${org.slug}`,
          include_bootstrap: true,
        },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('unauthorized');
      expect(body.error_description).toContain('Authentication required');
    });

    it('allows anonymous public-readable tool calls for public workspaces', async () => {
      const response = await post(`/api/${publicOrg.slug}/resolve_path`, {
        body: {
          path: `/${publicOrg.slug}`,
          include_bootstrap: true,
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.workspace.slug).toBe(publicOrg.slug);
      expect(body.workspace.type).toBe('organization');
    });

    it('rejects anonymous knowledge reads for private workspaces', async () => {
      const response = await post(`/api/${org.slug}/read_knowledge`, {
        body: { limit: 1 },
      });

      expect(response.status).toBe(401);
      const body = await response.json();
      expect(body.error).toBe('unauthorized');
    });
  });

  describe('Public Organization MCP', () => {
    async function initializePublicSession() {
      const initResponse = await post(`/mcp/${publicOrg.slug}`, {
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
      });

      const sessionId = initResponse.headers.get('mcp-session-id');
      expect(sessionId).toBeTruthy();

      await post(`/mcp/${publicOrg.slug}`, {
        body: {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        },
        headers: { 'mcp-session-id': sessionId! },
      });

      return sessionId!;
    }

    it('allows anonymous tools/list on public org MCP routes and hides mutating tools', async () => {
      const response = await post(`/mcp/${publicOrg.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      const toolNames = body.result.tools.map((tool: any) => tool.name);

      // Public reads survive: search_knowledge, search (SDK discovery).
      expect(toolNames).toContain('search_knowledge');
      expect(toolNames).toContain('search');
      // Writes and admin reads must not be visible to anonymous public callers.
      expect(toolNames).not.toContain('save_knowledge');
      expect(toolNames).not.toContain('query_sql');
      expect(toolNames).not.toContain('run');
      // Legacy `manage_*` tools are no longer registered as external MCP tools.
      expect(toolNames).not.toContain('manage_entity');
    });

    it('allows anonymous public-read tool calls on public org MCP routes', async () => {
      const sessionId = await initializePublicSession();

      const response = await post(`/mcp/${publicOrg.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'search_knowledge',
            arguments: { query: 'public-mcp-probe-nonexistent-12345' },
          },
        },
        headers: { 'mcp-session-id': sessionId },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.error).toBeUndefined();
      expect(body.result).toBeDefined();
    });

    it('requires auth for anonymous write attempts on public org MCP routes', async () => {
      const sessionId = await initializePublicSession();

      const response = await post(`/mcp/${publicOrg.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'save_knowledge',
            arguments: {
              content: 'public org write probe',
              kind: 'note',
              metadata: {},
            },
          },
        },
        headers: { 'mcp-session-id': sessionId },
      });

      expect(response.status).toBe(401);
      expect(response.headers.get('WWW-Authenticate')).toContain(
        '/.well-known/oauth-protected-resource'
      );
      const body = await response.json();
      expect(body.error).toBe('unauthorized');
    });

    it('allows consent approval for a public org resource even when the user is not a member', async () => {
      const response = await post('/oauth/authorize/consent', {
        body: {
          client_id: client.client_id,
          redirect_uri: client.redirect_uris[0],
          scope: 'mcp:read profile:read',
          state: 'public-org-consent-test',
          code_challenge: 'test-code-challenge',
          code_challenge_method: 'S256',
          resource: `http://localhost/mcp/${publicOrg.slug}`,
          approved: true,
        },
        cookie: sessionCookie,
        headers: { Origin: 'http://localhost' },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.redirect_url).toContain(client.redirect_uris[0]);
      expect(body.redirect_url).toContain('code=');
      expect(body.redirect_url).toContain('state=public-org-consent-test');
    });
  });

  describe('OAuth Access Token Authentication', () => {
    it('should accept valid OAuth access token', async () => {
      const { token } = await createTestAccessToken(user.id, org.id, client.client_id);

      const result = await mcpListTools({ token });

      expect(result.tools).toBeInstanceOf(Array);
      expect(result.tools.length).toBeGreaterThan(0);
    });

    it('allows a public-org scoped OAuth token for a non-member and only exposes public tools', async () => {
      const { token } = await createTestAccessToken(user.id, publicOrg.id, client.client_id, {
        scope: 'mcp:read profile:read',
      });

      const response = await post(`/mcp/${publicOrg.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
        token,
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      const toolNames = body.result.tools.map((tool: any) => tool.name);

      expect(toolNames).toContain('search_knowledge');
      expect(toolNames).toContain('search');
      expect(toolNames).not.toContain('save_knowledge');
      expect(toolNames).not.toContain('query_sql');
      expect(toolNames).not.toContain('run');
      expect(toolNames).not.toContain('manage_entity');
    });

    it('should reject expired OAuth access token', async () => {
      const { token } = await createExpiredAccessToken(user.id, org.id, client.client_id);

      const response = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
        token,
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('invalid_token');
    });

    it('should reject invalid OAuth access token', async () => {
      const response = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
        token: 'invalid_token_that_does_not_exist',
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('invalid_token');
    });

    it('should set organization context from token', async () => {
      const { token } = await createTestAccessToken(user.id, org.id, client.client_id);

      // Create an entity using the token's organization
      const response = await mcpRequest(
        'tools/call',
        {
          name: 'search_knowledge',
          arguments: { query: 'nonexistent-brand-12345' },
        },
        { token }
      );

      // Should succeed (even if entity not found) because auth works
      expect(response.error).toBeUndefined();
    });

    it('exposes list_organizations on unscoped /mcp for authenticated tokens', async () => {
      const { token } = await createTestAccessToken(user.id, org.id, client.client_id);

      const result = await mcpListTools({ token });
      const toolNames = result.tools.map((tool: any) => tool.name);

      expect(toolNames).toContain('list_organizations');
      expect(toolNames).not.toContain('switch_organization');
    });

    it('recovers a stale authenticated MCP session from the persisted session store', async () => {
      const { token } = await createTestAccessToken(user.id, org.id, client.client_id);

      const initResponse = await post(`/mcp/${org.slug}`, {
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

      await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        },
        headers: { 'mcp-session-id': sessionId! },
        token,
      });

      const persistedRows = await getTestDb()`
        SELECT organization_id
        FROM mcp_sessions
        WHERE session_id = ${sessionId}
      `;
      expect(persistedRows).toHaveLength(1);
      expect(persistedRows[0].organization_id).toBe(org.id);

      clearInMemoryMcpSessionsForTests();

      const recoveredResponse = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'search_knowledge',
            arguments: { query: 'recovery-probe-nonexistent-12345' },
          },
        },
        headers: { 'X-MCP-Format': 'json', 'mcp-session-id': sessionId! },
        token,
      });

      expect(recoveredResponse.status).toBe(200);
      const recoveredBody = await recoveredResponse.json();
      expect(recoveredBody.error).toBeUndefined();
      expect(recoveredBody.result?.isError).not.toBe(true);
    });

    it('binds an MCP session to a durable agent and updates last_used_at', async () => {
      const { token } = await createTestAccessToken(user.id, org.id, client.client_id);

      await mcpToolsCall(
        'search_knowledge',
        { query: 'nonexistent-brand-12345' },
        { token, agentId: agent.agentId }
      );

      const rows = await getTestDb()`
        SELECT last_used_at
        FROM agents
        WHERE id = ${agent.agentId}
          AND organization_id = ${org.id}
      `;

      expect(rows).toHaveLength(1);
      expect(rows[0].last_used_at).toBeTruthy();
    });

    it('revokes an MCP client only within the current organization', async () => {
      const scopedClient = await createTestOAuthClient({ client_name: 'Scoped Revoke Client' });
      const { token: orgToken } = await createTestAccessToken(
        user.id,
        org.id,
        scopedClient.client_id
      );
      await createTestAccessToken(user.id, org2.id, scopedClient.client_id);

      const initResponse = await post('/mcp', {
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
        token: orgToken,
      });
      const activeSessionId = initResponse.headers.get('mcp-session-id');
      expect(activeSessionId).toBeTruthy();

      await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        },
        headers: { 'mcp-session-id': activeSessionId! },
        token: orgToken,
      });

      const preRevokeResponse = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'search_knowledge',
            arguments: { query: 'revocation-check-before' },
          },
        },
        headers: { 'mcp-session-id': activeSessionId! },
      });
      expect(preRevokeResponse.status).toBe(200);

      await getTestDb()`
        INSERT INTO mcp_sessions (
          session_id,
          user_id,
          client_id,
          organization_id,
          member_role,
          requested_agent_id,
          is_authenticated,
          scoped_to_org,
          last_accessed_at,
          expires_at
        ) VALUES (
          'session-org-1',
          ${user.id},
          ${scopedClient.client_id},
          ${org.id},
          'owner',
          NULL,
          true,
          false,
          NOW(),
          NOW() + INTERVAL '1 hour'
        ), (
          'session-org-2',
          ${user.id},
          ${scopedClient.client_id},
          ${org2.id},
          'owner',
          NULL,
          true,
          false,
          NOW(),
          NOW() + INTERVAL '1 hour'
        )
      `;

      const response = await del(`/api/${org.slug}/clients/mcp/${scopedClient.client_id}`, {
        cookie: sessionCookie,
      });

      expect(response.status).toBe(200);

      const tokenRows = await getTestDb()`
        SELECT organization_id, revoked_at
        FROM oauth_tokens
        WHERE client_id = ${scopedClient.client_id}
        ORDER BY organization_id ASC
      `;
      expect(tokenRows).toHaveLength(2);
      const tokensByOrg = new Map(
        tokenRows.map((row) => [row.organization_id as string, row.revoked_at as Date | null])
      );
      expect(tokensByOrg.get(org.id)).toBeTruthy();
      expect(tokensByOrg.get(org2.id)).toBeNull();

      const sessionRows = await getTestDb()`
        SELECT session_id, organization_id
        FROM mcp_sessions
        WHERE client_id = ${scopedClient.client_id}
        ORDER BY session_id ASC
      `;
      expect(sessionRows).toHaveLength(1);
      expect(sessionRows[0].session_id).toBe('session-org-2');
      expect(sessionRows[0].organization_id).toBe(org2.id);

      const postRevokeResponse = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'search_knowledge',
            arguments: { query: 'revocation-check-after' },
          },
        },
        headers: { 'mcp-session-id': activeSessionId! },
      });
      expect(postRevokeResponse.status).not.toBe(200);

      const clientRows = await getTestDb()`
        SELECT id
        FROM oauth_clients
        WHERE id = ${scopedClient.client_id}
      `;
      expect(clientRows).toHaveLength(1);
    });

    it('rejects initialize when an authenticated client declares an unknown agent', async () => {
      const { token } = await createTestAccessToken(user.id, org.id, client.client_id);

      const response = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: '__test_init__',
          method: 'initialize',
          params: {
            protocolVersion: '2025-03-26',
            capabilities: {},
            clientInfo: {
              name: 'owletto-test',
              version: '1.0',
              agentId: 'missing-agent',
            },
          },
        },
        token,
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error?.message).toContain("Agent 'missing-agent' was not found");
    });

    it('exposes list_organizations on scoped /mcp/:org routes too', async () => {
      const { token } = await createTestAccessToken(user.id, org.id, client.client_id);

      const response = await post(`/mcp/${org.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
        token,
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      const toolNames = body.result.tools.map((tool: any) => tool.name);

      expect(toolNames).toContain('list_organizations');
      expect(toolNames).not.toContain('switch_organization');
    });
  });

  describe('Session Cookie Authentication', () => {
    it('exposes list_organizations on unscoped /mcp for authenticated browser sessions', async () => {
      const response = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
        cookie: sessionCookie,
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      const toolNames = body.result.tools.map((tool: any) => tool.name);

      expect(toolNames).toContain('list_organizations');
      expect(toolNames).not.toContain('switch_organization');
    });

    it('allows a signed-in non-member to call public-readable REST tools on a public org', async () => {
      const response = await post(`/api/${publicOrg.slug}/manage_entity`, {
        body: {
          action: 'list',
          entity_type: 'brand',
          limit: 50,
        },
        cookie: sessionCookie,
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.error).toBeUndefined();
      expect(body.entities).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: publicEntity.id,
            name: publicEntity.name,
            entity_type: publicEntity.entity_type,
          }),
        ])
      );
    });

    it('still blocks signed-in non-members from mutating a public org through REST tools', async () => {
      const response = await post(`/api/${publicOrg.slug}/manage_entity`, {
        body: {
          action: 'create',
          entity_type: 'brand',
          name: 'Should Not Be Created',
        },
        cookie: sessionCookie,
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body.error).toContain('not available for public access');
    });
  });

  describe('Personal Access Token Authentication', () => {
    it('should accept valid PAT (owl_pat_*)', async () => {
      const { token } = await createTestPAT(user.id, org.id);

      const result = await mcpListTools({ token });

      expect(result.tools).toBeInstanceOf(Array);
      expect(result.tools.length).toBeGreaterThan(0);
    });

    it('should reject invalid PAT format', async () => {
      const response = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
        token: 'owl_pat_invalid_token_hash',
      });

      expect(response.status).toBe(401);

      const body = await response.json();
      expect(body.error).toBe('invalid_token');
    });

    it('should reject org-bound PAT on a different organization route', async () => {
      const org2 = await createTestOrganization({ name: 'PAT Other Org' });
      await addUserToOrganization(user.id, org2.id);
      const { token } = await createTestPAT(user.id, org.id);

      const response = await post(`/mcp/${org2.slug}`, {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
        token,
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('forbidden');
      expect(body.error_description).toContain(
        'Token organization does not match URL organization'
      );
    });

    it('should reject PAT without owl_pat_ prefix', async () => {
      const response = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        },
        token: 'not_a_valid_pat_format',
      });

      expect(response.status).toBe(401);
    });
  });

  describe('JSON-RPC Error Handling', () => {
    it('should return JSON-RPC error for organization context missing', async () => {
      // Without token
      const response = await post('/mcp', {
        body: {
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: { name: 'search_knowledge', arguments: {} },
        },
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.error).toBeDefined();
      expect(body.error.code).toBe(-32001);
      expect(body.error.message).toContain('Organization context required');
    });

    it('should handle malformed JSON-RPC requests', async () => {
      const { token } = await createTestAccessToken(user.id, org.id, client.client_id);

      const response = await post('/mcp', {
        body: {
          // Missing jsonrpc version
          id: 1,
          method: 'tools/list',
        },
        token,
      });

      // Should either reject or handle gracefully
      expect(response.status).toBeLessThan(500);
      // Body should be valid JSON regardless of success/failure
      const body = await response.json();
      expect(body).toBeDefined();
    });
  });

  describe('tools/list Response', () => {
    it('should return list of available tools', async () => {
      const { token } = await createTestAccessToken(user.id, org.id, client.client_id);

      const result = await mcpListTools({ token });

      expect(result.tools).toBeInstanceOf(Array);

      // Verify expected tools are present. The legacy `manage_*`,
      // `read_knowledge`, `get_watcher`, `list_watchers` MCP tools are now
      // internal-only and reachable via the SDK from `run` / `query` scripts.
      const toolNames = result.tools.map((t: any) => t.name);
      expect(toolNames).toContain('search_knowledge');
      expect(toolNames).toContain('save_knowledge');
      expect(toolNames).toContain('search');
      expect(toolNames).toContain('query');
      expect(toolNames).toContain('run');
      expect(toolNames).not.toContain('execute');
      expect(toolNames).not.toContain('read_knowledge');
      expect(toolNames).not.toContain('get_watcher');
      expect(toolNames).not.toContain('list_watchers');
      expect(toolNames).not.toContain('manage_entity');
      // `manage_connections` and `manage_auth_profiles` stay public-MCP for
      // owletto-cli's browser-auth flow; flip to internal once the CLI migrates.
      expect(toolNames).toContain('manage_connections');
      expect(toolNames).toContain('manage_auth_profiles');
      expect(toolNames).not.toContain('join_organization');
    });

    it('should include tool descriptions', async () => {
      const { token } = await createTestAccessToken(user.id, org.id, client.client_id);

      const result = await mcpListTools({ token });

      for (const tool of result.tools) {
        expect(tool.name).toBeDefined();
        expect(tool.description).toBeDefined();
        expect(typeof tool.description).toBe('string');
      }
    });
  });

  describe('Device Flow Org Selection', () => {
    let deviceClient: Awaited<ReturnType<typeof createTestOAuthClient>>;

    beforeAll(async () => {
      deviceClient = await createTestOAuthClient({
        grant_types: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token'],
      });
    });

    it('should approve device code with explicit organization_id', async () => {
      const dc = await createTestDeviceCode(deviceClient.client_id);

      const response = await post('/oauth/device/approve', {
        body: {
          user_code: dc.userCode,
          approved: true,
          organization_id: org.id,
        },
        cookie: sessionCookie,
        headers: { Origin: 'http://localhost' },
      });

      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.status).toBe('approved');
    });

    it('should return org_selection_required without organization_id (no resource slug)', async () => {
      const dc = await createTestDeviceCode(deviceClient.client_id);

      const response = await post('/oauth/device/approve', {
        body: {
          user_code: dc.userCode,
          approved: true,
        },
        cookie: sessionCookie,
        headers: { Origin: 'http://localhost' },
      });

      const body = await response.json();
      expect(response.status).toBe(400);
      expect(body.error).toBe('org_selection_required');
      expect(body.organizations).toBeInstanceOf(Array);
      expect(body.organizations.length).toBeGreaterThanOrEqual(2);
      expect(body.organizations[0]).toHaveProperty('id');
      expect(body.organizations[0]).toHaveProperty('name');
      expect(body.organizations[0]).toHaveProperty('slug');
    });

    it('should use resource org slug when present (existing behavior)', async () => {
      const dc = await createTestDeviceCode(deviceClient.client_id, {
        resource: `http://localhost/mcp/${org.slug}`,
      });

      const response = await post('/oauth/device/approve', {
        body: {
          user_code: dc.userCode,
          approved: true,
        },
        cookie: sessionCookie,
        headers: { Origin: 'http://localhost' },
      });

      const body = await response.json();
      expect(response.status).toBe(200);
      expect(body.status).toBe('approved');
    });

    it('should reject device approve with invalid organization_id', async () => {
      const dc = await createTestDeviceCode(deviceClient.client_id);

      const response = await post('/oauth/device/approve', {
        body: {
          user_code: dc.userCode,
          approved: true,
          organization_id: 'org_nonexistent_12345',
        },
        cookie: sessionCookie,
        headers: { Origin: 'http://localhost' },
      });

      expect(response.status).toBe(403);
      const body = await response.json();
      expect(body.error).toBe('access_denied');
    });
  });
});
