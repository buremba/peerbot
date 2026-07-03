/**
 * Integration smoke for the `query_sdk` / `run_sdk` / memory tool surface.
 * Read-only Proxy semantics live in the sandbox unit
 * tests; this file guards the MCP surface annotations and the public-org
 * visitor read-only filter.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { mcpListTools, mcpToolsCall, post } from '../../setup/test-helpers';

describe('MCP query_sdk / run_sdk tool surface', () => {
  let token: string;
  let ownerOrgId: string;
  let ownerSlug: string;
  let publicSlug: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({ name: 'Query Tool Org', slug: 'query-tool-org' });
    ownerOrgId = org.id;
    ownerSlug = org.slug;
    const owner = await createTestUser({ email: 'query-tool@test.example.com' });
    await addUserToOrganization(owner.id, org.id, 'owner');
    const oauthClient = await createTestOAuthClient();
    token = (await createTestAccessToken(owner.id, org.id, oauthClient.client_id, { scope: 'mcp:read mcp:write mcp:admin' })).token;
    const publicOrg = await createTestOrganization({
      name: 'Query Tool Public',
      slug: 'query-tool-public',
      visibility: 'public',
    });
    publicSlug = publicOrg.slug;
  });

  it('exposes explicit SDK and memory tools with the expected annotations', async () => {
    const result = await mcpListTools({ token, orgSlug: ownerSlug });
    const byName = new Map<string, any>(result.tools.map((t: any) => [t.name, t]));
    expect(byName.has('execute')).toBe(false);
    // Assert the behavior-relevant hints specifically (not the whole object) so
    // adding display metadata like `title` doesn't couple this test to it.
    expect(byName.get('query_sdk')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('query_sdk')?.annotations?.idempotentHint).toBe(true);
    expect(byName.get('run_sdk')?.annotations?.destructiveHint).toBe(true);
    expect(byName.get('run_sdk')?.inputSchema?.properties?.dry_run).toBeTruthy();
    expect(byName.get('search_memory')?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get('search_memory')?.annotations?.idempotentHint).toBe(true);
    expect(byName.get('save_memory')?.annotations?.destructiveHint).toBe(false);
    expect(byName.has('search_knowledge')).toBe(false);
    expect(byName.has('save_knowledge')).toBe(false);
    expect(byName.has('search')).toBe(false);
    expect(byName.has('query')).toBe(false);
    expect(byName.has('run')).toBe(false);
  });

  it('surfaces outputSchema on structured tools', async () => {
    const result = await mcpListTools({ token, orgSlug: ownerSlug });
    const byName = new Map<string, any>(result.tools.map((t: any) => [t.name, t]));

    // Tools that declare an outputSchema carry it through to the listing...
    expect(byName.get('search_sdk')?.outputSchema?.type).toBe('object');
    expect(byName.get('search_memory')?.outputSchema?.type).toBe('object');
    expect(byName.get('manage_watchers')?.outputSchema).toBeTruthy();
    // ...while tools without one (text-only results) omit it.
    expect(byName.get('save_memory')?.outputSchema).toBeUndefined();
  });

  it('records query_sql audit rows in the append-only events ledger', async () => {
    await mcpToolsCall(
      'query_sql',
      { sql: 'SELECT id, organization_id FROM events', sort_by: 'id', limit: 1 },
      { token, orgSlug: ownerSlug }
    );

    const sql = getDb();
    const rows = await sql<
      Array<{
        semantic_type: string;
        origin_type: string | null;
        payload_type: string;
        payload_data: Record<string, unknown>;
        metadata: Record<string, unknown>;
      }>
    >`
      SELECT semantic_type, origin_type, payload_type, payload_data, metadata
      FROM events
      WHERE organization_id = ${ownerOrgId}
        AND semantic_type = 'audit'
        AND origin_type = 'tool_invocation'
        AND payload_data->>'tool_name' = 'query_sql'
      ORDER BY id DESC
      LIMIT 1
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0].payload_type).toBe('empty');
    expect(rows[0].metadata.category).toBe('audit');
    expect(rows[0].payload_data.success).toBe(true);
    expect(rows[0].payload_data.sql_sha256).toEqual(expect.any(String));
    expect(rows[0].payload_data.sql_preview_redacted).toContain('SELECT id');
    expect(rows[0].payload_data).not.toHaveProperty('rows');
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

    // Public-readable tools survive: search_memory and search_sdk (SDK discovery).
    expect(names).toContain('search_memory');
    expect(names).toContain('search_sdk');
    // Write surface and admin-tier reads must be filtered out for anonymous
    // visitors — including `query_sdk`, `run_sdk`, `query_sql`.
    expect(names).not.toContain('save_memory');
    expect(names).not.toContain('save_knowledge');
    expect(names).not.toContain('run_sdk');
    expect(names).not.toContain('query_sdk');
    expect(names).not.toContain('query_sql');
  });
});
