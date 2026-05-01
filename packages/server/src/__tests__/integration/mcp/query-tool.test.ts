/**
 * Integration smoke for the `query` / `run` rename + `save_knowledge`
 * append-only annotation. Read-only Proxy semantics live in the sandbox unit
 * tests; this file guards the MCP surface annotations and the public-org
 * visitor read-only filter.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { mcpListTools, post } from '../../setup/test-helpers';

describe('MCP query / run tool surface', () => {
  let token: string;
  let publicSlug: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'Query Tool Org', slug: 'query-tool-org' });
    const owner = await createTestUser({ email: 'query-tool@test.example.com' });
    await addUserToOrganization(owner.id, org.id, 'owner');
    const oauthClient = await createTestOAuthClient();
    token = (await createTestAccessToken(owner.id, org.id, oauthClient.client_id)).token;
    const publicOrg = await createTestOrganization({
      name: 'Query Tool Public',
      slug: 'query-tool-public',
      visibility: 'public',
    });
    publicSlug = publicOrg.slug;
  });

  it('exposes query, run, save_knowledge with the expected annotations', async () => {
    const result = await mcpListTools({ token });
    const byName = new Map<string, any>(result.tools.map((t: any) => [t.name, t]));
    expect(byName.has('execute')).toBe(false);
    expect(byName.get('query')?.annotations).toEqual({ readOnlyHint: true, idempotentHint: true });
    expect(byName.get('run')?.annotations).toEqual({ destructiveHint: true });
    expect(byName.get('save_knowledge')?.annotations).toEqual({ readOnlyHint: true });
  });

  it('hides write tools from anonymous visitors on a public /mcp/{slug}', async () => {
    // Initialize an anonymous session against the scoped public-org URL.
    const initRes = await post(`/mcp/${publicSlug}`, {
      body: {
        jsonrpc: '2.0',
        id: 'init',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'public-visitor', version: '1.0' },
        },
      },
    });
    const sessionId = initRes.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const listRes = await post(`/mcp/${publicSlug}`, {
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      headers: { 'mcp-session-id': sessionId! },
    });
    const body = await listRes.json();
    const names = (body.result?.tools as Array<{ name: string }>).map((t) => t.name);

    // Public-readable tools survive: search_knowledge, search (SDK discovery).
    expect(names).toContain('search_knowledge');
    expect(names).toContain('search');
    // Write surface and admin-tier reads must be filtered out for anonymous
    // visitors — including the new `query`, `run`, `query_sql`.
    expect(names).not.toContain('save_knowledge');
    expect(names).not.toContain('run');
    expect(names).not.toContain('query');
    expect(names).not.toContain('query_sql');
  });
});
