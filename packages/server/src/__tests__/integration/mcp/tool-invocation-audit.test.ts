import { REDACTED_SENTINEL } from '@lobu/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { SCOPE_CHECK_NOT_APPLICABLE } from '../../../auth/tool-access';
import { getDb } from '../../../db/client';
import type { Env } from '../../../index';
import { type AuthContext, executeTool } from '../../../tools/execute';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { ensureMcpSession, mcpToolsCall } from '../../setup/test-helpers';

interface AuditRow {
  payload_data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

async function latestAuditRow(orgId: string, toolName: string): Promise<AuditRow | null> {
  const sql = getDb();
  const rows = await sql<AuditRow[]>`
    SELECT payload_data, metadata
    FROM events
    WHERE organization_id = ${orgId}
      AND semantic_type = 'audit'
      AND origin_type = 'tool_invocation'
      AND payload_data->>'tool_name' = ${toolName}
    ORDER BY id DESC
    LIMIT 1
  `;
  return rows[0] ?? null;
}

describe('tool invocation audit coverage', () => {
  let token: string;
  let orgId: string;
  let orgSlug: string;
  let ownerId: string;
  let clientId: string;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({
      name: 'Audit Coverage Org',
      slug: 'audit-coverage-org',
    });
    orgId = org.id;
    orgSlug = org.slug;
    const owner = await createTestUser({ email: 'audit-coverage@test.example.com' });
    ownerId = owner.id;
    await addUserToOrganization(owner.id, org.id, 'owner');
    const oauthClient = await createTestOAuthClient();
    clientId = oauthClient.client_id;
    token = (
      await createTestAccessToken(owner.id, org.id, oauthClient.client_id, {
        scope: 'mcp:read mcp:write mcp:admin',
      })
    ).token;
  });

  function authCtxFor(tokenType: 'oauth' | 'pat' | 'session'): AuthContext {
    return {
      organizationId: orgId,
      tokenOrganizationId: tokenType === 'session' ? null : orgId,
      userId: ownerId,
      memberRole: 'owner',
      agentId: null,
      requestedAgentId: null,
      isAuthenticated: true,
      clientId: tokenType === 'oauth' ? clientId : null,
      scopes:
        tokenType === 'session'
          ? [...SCOPE_CHECK_NOT_APPLICABLE]
          : ['mcp:read', 'mcp:write', 'mcp:admin'],
      tokenType,
      requestUrl: 'http://localhost/lobu/tools/test',
      baseUrl: 'http://localhost',
      scopedToOrg: false,
      allowCrossOrg: tokenType === 'oauth',
    };
  }

  it('audits a generic OAuth MCP call with its session id', async () => {
    await mcpToolsCall(
      'search_memory',
      { query: 'audit coverage probe', limit: 1 },
      { token, orgSlug }
    );
    const sessionId = await ensureMcpSession({ token, orgSlug });

    const row = await latestAuditRow(orgId, 'search_memory');
    expect(row).not.toBeNull();
    expect(row!.payload_data.success).toBe(true);
    expect(row!.payload_data.args_sha256).toEqual(expect.any(String));
    expect(row!.payload_data.args_preview_redacted).toContain('audit coverage probe');
    expect(row!.payload_data).not.toHaveProperty('content');
    expect(row!.metadata.mcp_session_id).toBe(sessionId);
  });

  it('records the requested org_slug on query_sql audit rows', async () => {
    const result = (await executeTool(
      'query_sql',
      { sql: 'SELECT id FROM events', sort_by: 'id', limit: 1, org_slug: orgSlug },
      {} as Env,
      authCtxFor('oauth')
    )) as { error?: string };
    expect(result.error).toBeUndefined();

    const row = await latestAuditRow(orgId, 'query_sql');
    expect(row).not.toBeNull();
    expect(row!.payload_data.org_slug).toBe(orgSlug);
    expect(row!.metadata).toHaveProperty('mcp_session_id', null);
  });

  it('does NOT write generic audit rows for browser-session tool calls', async () => {
    const before = await latestAuditRow(orgId, 'list_metrics');
    expect(before).toBeNull();

    await executeTool('list_metrics', {}, {} as Env, authCtxFor('session'));

    expect(await latestAuditRow(orgId, 'list_metrics')).toBeNull();
  });

  it('still audits query_sql for browser-session callers (detailed audit is token-type independent)', async () => {
    await executeTool(
      'query_sql',
      { sql: 'SELECT id FROM entities', sort_by: 'id', limit: 1 },
      {} as Env,
      authCtxFor('session')
    );

    const sql = getDb();
    const rows = await sql`
      SELECT id FROM events
      WHERE organization_id = ${orgId}
        AND semantic_type = 'audit'
        AND payload_data->>'tool_name' = 'query_sql'
        AND payload_data->>'sql_preview_redacted' LIKE '%FROM entities%'
    `;
    expect(rows).toHaveLength(1);
  });

  it('audits a failed generic call with the error captured', async () => {
    await expect(
      executeTool(
        'manage_connections',
        { action: 'nope', token: 'must-not-reach-the-audit-log' },
        {} as Env,
        authCtxFor('pat')
      )
    ).rejects.toThrow();

    const row = await latestAuditRow(orgId, 'manage_connections');
    expect(row).not.toBeNull();
    expect(row!.payload_data.success).toBe(false);
    expect(row!.payload_data.error).toBeTruthy();
    expect(row!.payload_data.args_preview_redacted).not.toContain(
      'must-not-reach-the-audit-log'
    );
    expect(row!.payload_data.args_preview_redacted).toContain(REDACTED_SENTINEL);
  });

  it('audits org-agnostic list_organizations under the bound org (early-return path)', async () => {
    await executeTool('list_organizations', {}, {} as Env, authCtxFor('oauth'));

    const row = await latestAuditRow(orgId, 'list_organizations');
    expect(row).not.toBeNull();
    expect(row!.payload_data.success).toBe(true);
  });

  it('records resolved tool failures as failed', async () => {
    const result = (await executeTool(
      'manage_classifiers',
      { action: 'delete' },
      {} as Env,
      authCtxFor('pat')
    )) as { success: boolean };
    expect(result.success).toBe(false);

    const row = await latestAuditRow(orgId, 'manage_classifiers');
    expect(row).not.toBeNull();
    expect(row!.payload_data.success).toBe(false);
    expect(row!.payload_data.error).toMatchObject({
      message: 'Missing required field: classifier_id',
    });
  });
});
