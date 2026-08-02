import { createHash } from 'node:crypto';
import { REDACTED_SENTINEL } from '@lobu/core';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { SCOPE_CHECK_NOT_APPLICABLE } from '../../../auth/tool-access';
import {
  decodeToolInvocationSnapshot,
  getToolInvocationSnapshotForCaller,
  recordToolInvocationAudit,
} from '../../../tools/audit';
import { getDb } from '../../../db/client';
import type { Env } from '../../../index';
import { restGetToolInvocationSnapshot } from '../../../rest-api';
import { type AuthContext, executeTool } from '../../../tools/execute';
import { getContent } from '../../../tools/get_content';
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
import { insertEvent } from '../../../utils/insert-event';

interface AuditRow {
  id: string | number;
  payload_data: Record<string, unknown>;
  metadata: Record<string, unknown>;
}

function decryptSnapshot(row: AuditRow): {
  request: Record<string, unknown>;
  response: unknown;
} {
  const ciphertext = row.payload_data.snapshot_ciphertext;
  expect(ciphertext).toEqual(expect.any(String));
  return decodeToolInvocationSnapshot(row.payload_data);
}

async function latestAuditRow(orgId: string, toolName: string): Promise<AuditRow | null> {
  const sql = getDb();
  const rows = await sql<AuditRow[]>`
    SELECT id, payload_data, metadata
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
    // The preview keeps the call SHAPE (keys), never free-text values — a
    // search query is user content and could carry a pasted secret.
    expect(row!.payload_data.args_preview_redacted).toContain('"query"');
    expect(row!.payload_data.args_preview_redacted).not.toContain('audit coverage probe');
    expect(row!.payload_data.args_preview_redacted).toContain(REDACTED_SENTINEL);
    expect(row!.payload_data).not.toHaveProperty('content');
    expect(row!.payload_data.snapshot_version).toBe(1);
    expect(row!.payload_data.snapshot_status).toBe('complete');
    expect(decryptSnapshot(row!).request).toMatchObject({
      query: 'audit coverage probe',
      limit: 1,
    });
    expect(row!.metadata.mcp_session_id).toBe(sessionId);
    expect(row!.metadata.call_id).toEqual(expect.any(String));
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
    const snapshot = decryptSnapshot(row!);
    expect(snapshot.request).toEqual({
      sql: 'SELECT id FROM events',
      sort_by: 'id',
      limit: 1,
      org_slug: orgSlug,
    });
    expect(snapshot.response).toMatchObject({ rows: expect.any(Array) });
    expect(row!.metadata).toHaveProperty('mcp_session_id', null);
  });

  it('reads a snapshot by event id only for its creator or an admin', async () => {
    const row = await latestAuditRow(orgId, 'query_sql');
    expect(row).not.toBeNull();
    const eventId = String(row!.id);

    const creatorRead = await getToolInvocationSnapshotForCaller({
      eventId,
      organizationId: orgId,
      userId: ownerId,
      memberRole: 'member',
    });
    expect(creatorRead.status).toBe('ok');

    const otherMemberRead = await getToolInvocationSnapshotForCaller({
      eventId,
      organizationId: orgId,
      userId: 'another-user',
      memberRole: 'member',
    });
    expect(otherMemberRead).toEqual({ status: 'forbidden' });

    const adminRead = await getToolInvocationSnapshotForCaller({
      eventId,
      organizationId: orgId,
      userId: 'another-user',
      memberRole: 'admin',
    });
    expect(adminRead.status).toBe('ok');

    const listRead = await getContent(
      { content_ids: [Number(row!.id)] },
      {} as Env,
      {
        organizationId: orgId,
        userId: ownerId,
        memberRole: 'owner',
        isAuthenticated: true,
        tokenType: 'session',
        scopedToOrg: true,
        allowCrossOrg: false,
      } as never
    );
    expect(listRead.content).toHaveLength(1);
    expect(listRead.content[0].payload_data).toMatchObject({
      snapshot_version: 1,
      snapshot_status: 'complete',
    });
    expect(listRead.content[0].payload_data).not.toHaveProperty('snapshot_ciphertext');
    expect(listRead.content[0].payload_data).not.toHaveProperty('snapshot_sha256');
  });

  it('does not expose snapshot bodies through query_sql events.payload_data', async () => {
    const result = (await executeTool(
      'query_sql',
      {
        sql: `SELECT payload_data FROM events
              WHERE payload_data->>'tool_name' = 'query_sql'
                AND payload_data->>'snapshot_status' = 'complete'
              ORDER BY id DESC`,
        limit: 1,
      },
      {} as Env,
      authCtxFor('session')
    )) as { rows: Array<{ payload_data: Record<string, unknown> }> };

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].payload_data).toMatchObject({
      snapshot_version: 1,
      snapshot_status: 'complete',
    });
    expect(result.rows[0].payload_data).not.toHaveProperty('snapshot_ciphertext');
    expect(result.rows[0].payload_data).not.toHaveProperty('snapshot_sha256');
  });

  it('reports a snapshot-less audit row as unavailable instead of throwing', async () => {
    // Audit rows written before snapshots shipped carry no snapshot fields.
    // Decoding one throws, so the read path must recognise it up front —
    // otherwise every pre-existing row 500s on the direct-read route.
    await insertEvent({
      entityIds: [],
      organizationId: orgId,
      originId: 'tool_invocation:legacy-no-snapshot',
      title: 'legacy audit row',
      payloadType: 'empty',
      payloadData: { tool_name: 'probe_legacy_no_snapshot', success: true },
      semanticType: 'audit',
      originType: 'tool_invocation',
      metadata: { category: 'audit', tool_name: 'probe_legacy_no_snapshot' },
      createdBy: ownerId,
      clientId: null,
    });
    const row = await latestAuditRow(orgId, 'probe_legacy_no_snapshot');
    expect(row).not.toBeNull();
    expect(row!.payload_data).not.toHaveProperty('snapshot_ciphertext');

    const read = await getToolInvocationSnapshotForCaller({
      eventId: String(row!.id),
      organizationId: orgId,
      userId: ownerId,
      memberRole: 'owner',
    });
    expect(read).toEqual({ status: 'unavailable' });
  });

  it('serves the direct snapshot route to a session but rejects an unscoped token', async () => {
    const row = await latestAuditRow(orgId, 'query_sql');
    expect(row).not.toBeNull();

    const makeApp = (oauthWithoutReadScope: boolean) => {
      const app = new Hono<{ Bindings: Env }>();
      app.use('*', async (c, next) => {
        c.set('organizationId', orgId);
        c.set('memberRole', 'owner');
        c.set('mcpIsAuthenticated', true);
        c.set(
          'session',
          oauthWithoutReadScope ? null : ({ userId: ownerId } as never)
        );
        c.set(
          'mcpAuthInfo',
          oauthWithoutReadScope
            ? ({
                tokenType: 'access_token',
                userId: ownerId,
                organizationId: orgId,
                scopes: [],
              } as never)
            : null
        );
        await next();
      });
      app.get('/:eventId', restGetToolInvocationSnapshot);
      return app;
    };

    const allowed = await makeApp(false).request(`/${row!.id}`);
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toMatchObject({ status: 'ok' });

    const denied = await makeApp(true).request(`/${row!.id}`);
    expect(denied.status).toBe(404);

    const oversizedId = await makeApp(false).request('/999999999999999999999999');
    expect(oversizedId.status).toBe(404);
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

  it('still audits query_sdk for browser-session callers', async () => {
    // Must be a real sandbox entrypoint: a bare `return` does not compile as an
    // ES module, and a failed compile would leave `success: false` — asserting
    // the snapshot against the live result would then pass either way.
    const script = 'export default async () => ({ answer: 42 });';
    const result = (await executeTool(
      'query_sdk',
      { script },
      {} as Env,
      authCtxFor('session')
    )) as { success: boolean; return_value?: unknown };
    expect(result.success).toBe(true);
    expect(result.return_value).toEqual({ answer: 42 });

    const row = await latestAuditRow(orgId, 'query_sdk');
    expect(row).not.toBeNull();
    expect(decryptSnapshot(row!).request).toEqual({ script });
    expect(decryptSnapshot(row!).response).toMatchObject({
      success: true,
      return_value: { answer: 42 },
    });
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
    const snapshot = decryptSnapshot(row!);
    expect(snapshot.request).toMatchObject({
      action: 'nope',
      token: REDACTED_SENTINEL,
    });
  });

  it('args_sha256 is computed over SANITIZED args — a secret value cannot be verified against the hash', async () => {
    const argsWithSecretA = { query: 'probe', token: 'candidate-secret-A' };
    const argsWithSecretB = { query: 'probe', token: 'candidate-secret-B' };
    // `token` is not a search_sdk argument: validation rejects both calls, and
    // the audit fires on the catch path with the raw args — the exact moment a
    // raw-args hash would persist a credential-derived verifier.
    await expect(
      executeTool('search_sdk', argsWithSecretA, {} as Env, authCtxFor('pat'))
    ).rejects.toThrow();
    await expect(
      executeTool('search_sdk', argsWithSecretB, {} as Env, authCtxFor('pat'))
    ).rejects.toThrow();

    const sql = getDb();
    const rows = await sql<Array<{ payload_data: Record<string, unknown> }>>`
      SELECT payload_data FROM events
      WHERE organization_id = ${orgId}
        AND semantic_type = 'audit'
        AND payload_data->>'tool_name' = 'search_sdk'
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

  it('sentinels every caller-controlled leaf AND key — PINs, identifier-shaped values, credential-shaped keys', async () => {
    await recordToolInvocationAudit({
      toolName: 'probe_leaf_sanitization',
      args: {
        input: { pin: 123456 },
        kind: 'sk-live-credential-value',
        'sk-live-secret-as-a-key': 1,
        dry_run: true,
      },
      result: { ok: true },
      durationMs: 2,
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

    const row = await latestAuditRow(orgId, 'probe_leaf_sanitization');
    expect(row).not.toBeNull();
    const preview = String(row!.payload_data.args_preview_redacted);
    expect(preview).not.toContain('123456');
    expect(preview).not.toContain('sk-live-credential-value');
    expect(preview).not.toContain('sk-live-secret-as-a-key');
    // This probe tool has no registered schema, so NO key is trusted: the
    // whole preview collapses to sentinel structure with the boolean kept
    // (repeated sentinel keys merge; first key position, last value wins).
    expect(preview).toBe(`{"${REDACTED_SENTINEL}":true}`);
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
      // Name only — handler-supplied error text never reaches the ledger.
      expect(row!.payload_data.error).toEqual({ name: 'ToolError' });
    }
  );

  it('marks oversized snapshots without silently storing a truncated preview', async () => {
    await recordToolInvocationAudit({
      toolName: 'probe_oversized_snapshot',
      args: { probe: true },
      result: { blob: 'x'.repeat(2 * 1024 * 1024) },
      durationMs: 1,
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

    const row = await latestAuditRow(orgId, 'probe_oversized_snapshot');
    expect(row).not.toBeNull();
    expect(row!.payload_data.snapshot_status).toBe('too_large');
    expect(row!.payload_data.snapshot_bytes).toBeGreaterThan(2 * 1024 * 1024);
    expect(row!.payload_data).not.toHaveProperty('snapshot_ciphertext');
  });

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
          'curl --token sk-live-1234567890',
          'the token is sk-live-abcdef',
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
      'sk-live-1234567890',
      'sk-live-abcdef',
    ]) {
      expect(preview).not.toContain(fragment);
    }
    const snapshot = JSON.stringify(decryptSnapshot(row!));
    for (const fragment of [
      'my secret value',
      'dXNlcjpwYXNz',
      'part2',
      'mufasa',
      'testrealm',
      'dcd98b7102dd',
      '6629fae49393',
      'scar',
      'abc9f8de77',
      'sk-live-1234567890',
      'sk-live-abcdef',
    ]) {
      expect(snapshot).not.toContain(fragment);
    }
  });

  it('query_sql preview redaction consumes complete credentials (the pattern path the generic sentinel does not cover)', async () => {
    // The generic path sentinels everything before the regexes run; query_sql
    // and run_sdk previews are where pattern redaction still carries the load.
    const sql = [
      "SELECT /* redaction-probe */ 'password=\"my secret value\"',",
      "'authorization: Basic dXNlcjpwYXNz',",
      '\'Digest username="mufasa", realm="testrealm", response="6629fae49393"\',',
      "'token=part1,part2' FROM events",
    ].join(' ');
    await executeTool('query_sql', { sql, limit: 1 }, {} as Env, authCtxFor('oauth'));

    const db = getDb();
    const rows = await db<Array<{ payload_data: Record<string, unknown> }>>`
      SELECT payload_data FROM events
      WHERE organization_id = ${orgId}
        AND semantic_type = 'audit'
        AND payload_data->>'tool_name' = 'query_sql'
        AND payload_data->>'sql_preview_redacted' LIKE '%redaction-probe%'
      ORDER BY id DESC
      LIMIT 1
    `;
    expect(rows).toHaveLength(1);
    const preview = String(rows[0].payload_data.sql_preview_redacted);
    for (const fragment of [
      'my secret value',
      'dXNlcjpwYXNz',
      'mufasa',
      'testrealm',
      '6629fae49393',
      'part2',
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
    expect(row!.payload_data.error).toMatchObject({ name: expect.any(String) });
    expect(row!.payload_data.error).not.toHaveProperty('message');
  });
});
