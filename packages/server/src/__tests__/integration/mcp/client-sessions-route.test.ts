/** Integration coverage for org-scoped MCP session activity. */

import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { recordToolInvocationAudit } from '../../../tools/audit';
import type { ToolContext } from '../../../tools/registry';
import { insertEvent } from '../../../utils/insert-event';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { get } from '../../setup/test-helpers';

describe('client sessions activity route', () => {
  let token: string;
  let orgId: string;
  let orgSlug: string;
  let ownerId: string;
  let clientId: string;
  let clientName: string;
  let otherOrgId: string;

  function auditCtx(overrides: Partial<ToolContext> = {}): ToolContext {
    return {
      organizationId: orgId,
      userId: ownerId,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      clientId,
      agentId: 'session-agent',
      scopedToOrg: false,
      allowCrossOrg: true,
      ...overrides,
    } as ToolContext;
  }

  async function recordCall(
    sessionId: string,
    toolName: string,
    overrides: Partial<ToolContext> = {},
    result: Record<string, unknown> = { ok: true }
  ): Promise<void> {
    await recordToolInvocationAudit({
      toolName,
      args: { query: 'probe' },
      result,
      durationMs: 3,
      ctx: auditCtx({ mcpSessionId: sessionId, ...overrides }),
    });
  }

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    const org = await createTestOrganization({
      name: 'Sessions Route Org',
      slug: 'sessions-route-org',
    });
    orgId = org.id;
    orgSlug = org.slug;
    const owner = await createTestUser({ email: 'sessions-route@test.example.com' });
    ownerId = owner.id;
    await addUserToOrganization(owner.id, org.id, 'owner');
    clientName = 'Sessions Probe App';
    const oauthClient = await createTestOAuthClient({ client_name: clientName });
    clientId = oauthClient.client_id;
    token = (
      await createTestAccessToken(owner.id, org.id, oauthClient.client_id, {
        scope: 'mcp:read mcp:write mcp:admin',
      })
    ).token;
    const otherOrg = await createTestOrganization({
      name: 'Sessions Route Other',
      slug: 'sessions-route-other',
    });
    otherOrgId = otherOrg.id;

    // Session A: two calls, one pending approval linked by the session stamp.
    await recordCall('sess-alpha', 'search_memory');
    await recordCall('sess-alpha', 'query_sql', {}, { error: 'probe failure' });
    await insertEvent({
      entityIds: [],
      organizationId: orgId,
      originId: 'sess-alpha-approval',
      title: 'Create Issue — pending approval',
      semanticType: 'operation',
      interactionType: 'approval',
      interactionStatus: 'pending',
      clientId,
      metadata: { mcp_session_id: 'sess-alpha' },
    });

    // Session B sorts first: pin session A an hour back so ordering does not
    // depend on sub-millisecond insertion timing.
    const db = getDb();
    await db`
      UPDATE events SET occurred_at = now() - interval '1 hour'
      WHERE organization_id = ${orgId}
        AND semantic_type = 'audit'
        AND metadata->>'mcp_session_id' = 'sess-alpha'
    `;
    await recordCall('sess-beta', 'search_sdk');

    // Cross-org session: must never appear for orgSlug.
    await recordCall('sess-foreign', 'search_memory', {
      organizationId: otherOrgId,
    } as Partial<ToolContext>);

    // Stale session: outside the activity window.
    await recordCall('sess-stale', 'search_memory');
    const sql = getDb();
    await sql`
      UPDATE events SET occurred_at = now() - interval '30 days'
      WHERE organization_id = ${orgId}
        AND metadata->>'mcp_session_id' = 'sess-stale'
    `;
  });

  it('lists recent sessions newest-first with counts, tools, client identity, and pending interactions', async () => {
    const res = await get(`/api/${orgSlug}/clients/sessions`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessions: Array<{
        sessionId: string;
        clientId: string | null;
        clientName: string | null;
        userId: string | null;
        agentId: string | null;
        firstCallAt: number;
        failedCount: number;
        callCount: number;
        tools: string[];
        pendingInteractionCount: number;
        lastCallAt: number;
      }>;
    };

    const ids = body.sessions.map((s) => s.sessionId);
    expect(ids).toEqual(['sess-beta', 'sess-alpha']);
    expect(ids).not.toContain('sess-foreign');
    expect(ids).not.toContain('sess-stale');

    const alpha = body.sessions.find((s) => s.sessionId === 'sess-alpha')!;
    expect(alpha.callCount).toBe(2);
    expect(alpha.failedCount).toBe(1);
    expect(alpha.tools).toEqual(['query_sql', 'search_memory']);
    expect(alpha.clientId).toBe(clientId);
    expect(alpha.clientName).toBe(clientName);
    expect(alpha.userId).toBe(ownerId);
    expect(alpha.agentId).toBe('session-agent');
    expect(alpha.firstCallAt).toBeLessThanOrEqual(alpha.lastCallAt);
    expect(alpha.pendingInteractionCount).toBe(1);

    const beta = body.sessions.find((s) => s.sessionId === 'sess-beta')!;
    expect(beta.callCount).toBe(1);
    expect(beta.pendingInteractionCount).toBe(0);
  });

  it('honors the bounded result limit', async () => {
    const res = await get(`/api/${orgSlug}/clients/sessions?limit=1`, { token });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessions: Array<{ sessionId: string }> };
    expect(body.sessions.map((session) => session.sessionId)).toEqual(['sess-beta']);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await get(`/api/${orgSlug}/clients/sessions`);
    expect(res.status).toBe(401);
  });
});
