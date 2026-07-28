import { createHash } from 'node:crypto';
import { REDACTED_SENTINEL } from '@lobu/core';
import { beforeAll, describe, expect, it } from 'vitest';
import { SCOPE_CHECK_NOT_APPLICABLE } from '../../../auth/tool-access';
import { recordToolInvocationAudit } from '../../../tools/audit';
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

  it('args_sha256 is computed over REDACTED args — a secret value cannot be verified against the hash', async () => {
    const argsWithSecretA = { action: 'nope', token: 'candidate-secret-A' };
    const argsWithSecretB = { action: 'nope', token: 'candidate-secret-B' };
    await expect(
      executeTool('manage_connections', argsWithSecretA, {} as Env, authCtxFor('pat'))
    ).rejects.toThrow();
    await expect(
      executeTool('manage_connections', argsWithSecretB, {} as Env, authCtxFor('pat'))
    ).rejects.toThrow();

    const sql = getDb();
    const rows = await sql<Array<{ payload_data: Record<string, unknown> }>>`
      SELECT payload_data FROM events
      WHERE organization_id = ${orgId}
        AND semantic_type = 'audit'
        AND payload_data->>'tool_name' = 'manage_connections'
        AND payload_data->>'args_preview_redacted' LIKE '%"action":"nope"%'
      ORDER BY id DESC
      LIMIT 2
    `;
    expect(rows).toHaveLength(2);
    // Same call shape, different secret value → identical hash. If the raw
    // args fed the hash, the two digests would differ and either could be
    // used as an offline verifier for candidate secrets.
    expect(rows[0].payload_data.args_sha256).toBe(rows[1].payload_data.args_sha256);
    const rawHashA = createHash('sha256')
      .update(JSON.stringify(argsWithSecretA))
      .digest('hex');
    expect(rows[0].payload_data.args_sha256).not.toBe(rawHashA);
  });

  it.each(['error', 'timeout'] as const)(
    'records a result with status=%s as a failed invocation',
    async (status) => {
      const toolName = `probe_status_${status}`;
      await recordToolInvocationAudit({
        toolName,
        args: { probe: true },
        result: { status, message: `soft ${status} outcome` },
        durationMs: 5,
        ctx: {
          organizationId: orgId,
          userId: ownerId,
          memberRole: 'owner',
          isAuthenticated: true,
          tokenType: 'pat',
          scopedToOrg: false,
          allowCrossOrg: false,
        } as never,
      });

      const row = await latestAuditRow(orgId, toolName);
      expect(row).not.toBeNull();
      expect(row!.payload_data.success).toBe(false);
      expect(row!.payload_data.error).toMatchObject({
        message: `soft ${status} outcome`,
      });
    }
  );

  it('fully redacts secrets embedded in NON-secret string fields (quoted values, Basic auth, comma-delimited)', async () => {
    // deepRedactSecrets only covers denylisted KEYS; secrets pasted into free
    // text (a note, a script arg) rely on the text patterns, which must consume
    // the complete credential — not stop at the first space, comma, or scheme
    // word and leak the remainder into the preview.
    await recordToolInvocationAudit({
      toolName: 'probe_freetext_redaction',
      args: {
        // token= sits BEFORE authorization: the header pattern consumes the
        // rest of the value, so a later position would not prove the
        // comma-delimited assignment branch on its own.
        note: [
          'token=part1,part2',
          'password="my secret value"',
          'authorization: Basic dXNlcjpwYXNz',
        ].join(' | '),
        digest_header:
          'authorization: Digest username="mufasa", realm="testrealm", nonce="dcd98b7102dd", response="6629fae49393"',
        bare_digest: 'Digest username="scar", uri="/dir/index.html", response="abc9f8de77"',
      },
      result: { ok: true },
      durationMs: 3,
      ctx: {
        organizationId: orgId,
        userId: ownerId,
        memberRole: 'owner',
        isAuthenticated: true,
        tokenType: 'pat',
        scopedToOrg: false,
        allowCrossOrg: false,
      } as never,
    });

    const row = await latestAuditRow(orgId, 'probe_freetext_redaction');
    expect(row).not.toBeNull();
    const preview = String(row!.payload_data.args_preview_redacted);
    expect(preview).not.toContain('my secret value');
    expect(preview).not.toContain('secret value');
    expect(preview).not.toContain('dXNlcjpwYXNz');
    expect(preview).not.toContain('part2');
    // Digest parameters are credential material end to end — none of the
    // quoted values may survive, with or without the authorization: prefix.
    for (const fragment of [
      'mufasa',
      'testrealm',
      'dcd98b7102dd',
      '6629fae49393',
      'scar',
      'abc9f8de77',
    ]) {
      expect(preview).not.toContain(fragment);
    }
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
