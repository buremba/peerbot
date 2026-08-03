/** Integration coverage for org-scoped MCP session activity. */

import { beforeAll, describe, expect, it } from 'vitest';
import { getDb } from '../../../db/client';
import { recordMcpConversationActivity } from '../../../lobu/stores/mcp-client-conversations';
import { recordToolInvocationAudit } from '../../../tools/audit';
import { isSoftErrorResult } from '../../../tools/execute';
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
    const ctx = auditCtx({ mcpSessionId: sessionId, ...overrides });
    await recordToolInvocationAudit({
      toolName,
      args: { query: 'probe' },
      result,
      durationMs: 3,
      ctx,
    });
    // The route reads the write-time projection, so seed it exactly the way
    // `executeTool` does after each audit row.
    await recordMcpConversationActivity({
      ctx,
      toolName,
      failed: isSoftErrorResult(result),
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
      UPDATE mcp_client_conversations
      SET first_activity_at = now() - interval '2 hours',
        last_activity_at = now() - interval '1 hour'
      WHERE organization_id = ${orgId} AND conversation_id = 'sess-alpha'
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
      UPDATE mcp_client_conversations
      SET first_activity_at = now() - interval '30 days',
        last_activity_at = now() - interval '30 days'
      WHERE organization_id = ${orgId} AND conversation_id = 'sess-stale'
    `;

    for (let index = 0; index < 10; index += 1) {
      await recordCall('sess-tool-cap', `tool_${index}`);
    }
    await sql`
      UPDATE mcp_client_conversations
      SET first_activity_at = now() - interval '2 hours',
        last_activity_at = now() - interval '2 hours'
      WHERE organization_id = ${orgId} AND conversation_id = 'sess-tool-cap'
    `;

    // PAT callers have a synthetic `pat_<id>` client identity but no matching
    // oauth_clients row. The projection keeps that identity in its key while
    // storing a null display-client foreign key.
    await recordCall('sess-pat', 'search_memory', {
      clientId: 'pat_1',
      tokenType: 'pat',
    } as Partial<ToolContext>);
    await sql`
      UPDATE mcp_client_conversations
      SET first_activity_at = now() - interval '3 hours',
        last_activity_at = now() - interval '3 hours'
      WHERE organization_id = ${orgId} AND conversation_id = 'sess-pat'
    `;

    // One host conversation can reconnect through multiple transport sessions.
    // Pending approvals from an earlier transport must remain attached.
    await recordCall('transport-old', 'search_memory', {
      mcpConversationId: 'host-conversation',
    });
    await recordCall('transport-new', 'query_sql', {
      mcpConversationId: 'host-conversation',
    });
    await insertEvent({
      entityIds: [],
      organizationId: orgId,
      originId: 'host-conversation-approval',
      title: 'Earlier transport approval',
      semanticType: 'operation',
      interactionType: 'approval',
      interactionStatus: 'pending',
      clientId,
      metadata: { mcp_session_id: 'transport-old' },
    });
    await sql`
      UPDATE mcp_client_conversations
      SET first_activity_at = now() - interval '5 hours',
        last_activity_at = now() - interval '4 hours'
      WHERE organization_id = ${orgId} AND conversation_id = 'host-conversation'
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
        lastAction: string;
      }>;
    };

    const ids = body.sessions.map((s) => s.sessionId);
    expect(ids).toEqual([
      'sess-beta',
      'sess-alpha',
      'sess-tool-cap',
      'sess-pat',
      'host-conversation',
    ]);
    expect(ids).not.toContain('sess-foreign');
    expect(ids).not.toContain('sess-stale');

    const alpha = body.sessions.find((s) => s.sessionId === 'sess-alpha')!;
    expect(alpha.callCount).toBe(2);
    expect(alpha.failedCount).toBe(1);
    // The projection appends each new tool in first-use order.
    expect(alpha.tools).toEqual(['search_memory', 'query_sql']);
    expect(alpha.clientId).toBe(clientId);
    expect(alpha.clientName).toBe(clientName);
    expect(alpha.userId).toBe(ownerId);
    expect(alpha.agentId).toBe('session-agent');
    expect(alpha.firstCallAt).toBeLessThanOrEqual(alpha.lastCallAt);
    expect(alpha.pendingInteractionCount).toBe(1);
    // `last_action` stores the raw tool name even when the tool declares an
    // `annotations.title`; the route is the only place it gets formatted.
    const [stored] = await getDb()<{ last_action: string }>`
      SELECT last_action FROM mcp_client_conversations
      WHERE organization_id = ${orgId} AND conversation_id = 'sess-alpha'
    `;
    expect(stored.last_action).toBe('query_sql');
    expect(alpha.lastAction).toBe('Query SQL');

    const beta = body.sessions.find((s) => s.sessionId === 'sess-beta')!;
    expect(beta.callCount).toBe(1);
    expect(beta.pendingInteractionCount).toBe(0);

    const capped = body.sessions.find((s) => s.sessionId === 'sess-tool-cap')!;
    expect(capped.tools).toHaveLength(8);

    // Listed despite `pat_1` not being an oauth_clients row.
    const pat = body.sessions.find((s) => s.sessionId === 'sess-pat')!;
    expect(pat.clientId).toBeNull();
    expect(pat.clientName).toBeNull();
    expect(pat.callCount).toBe(1);

    const host = body.sessions.find((s) => s.sessionId === 'host-conversation')!;
    expect(host.callCount).toBe(2);
    expect(host.pendingInteractionCount).toBe(1);
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
