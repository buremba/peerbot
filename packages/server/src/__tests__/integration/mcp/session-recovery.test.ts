/**
 * MCP session recovery semantics.
 *
 * MCP sessions live on a 1h sliding TTL (`SESSION_MAX_AGE_MS`). When a session
 * ages out, both the in-memory transport (per-pod cleanup) and the persisted
 * row (`DELETE FROM mcp_sessions WHERE expires_at <= NOW()`) disappear.
 *
 * Recovery is allowed ONLY from a persisted, server-issued session row (a
 * cross-replica hop / pod restart within the TTL) — that proves the id was
 * genuinely issued. An id with no persisted record (expired, or never issued)
 * must NOT be resurrected from request auth alone, because that would let a
 * caller create a session under any id they supply. Per the MCP Streamable
 * HTTP spec, those return 404 so the client re-initializes with a fresh
 * server-generated id. The error message is human-friendly and actionable.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clearInMemoryMcpSessionsForTests } from '../../../mcp-handler';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { get, post } from '../../setup/test-helpers';

describe('MCP session recovery', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let publicOrg: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let client: Awaited<ReturnType<typeof createTestOAuthClient>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Recovery Org' });
    publicOrg = await createTestOrganization({ name: 'Recovery Public Org', visibility: 'public' });
    user = await createTestUser({});
    await addUserToOrganization(user.id, org.id);
    client = await createTestOAuthClient();
  });

  beforeEach(() => {
    clearInMemoryMcpSessionsForTests();
  });

  /** Initialize a session and return its id (does the notifications/initialized handshake). */
  async function initSession(opts: { token?: string; orgSlug: string }): Promise<string> {
    const path = `/mcp/${opts.orgSlug}`;
    const res = await post(path, {
      body: {
        jsonrpc: '2.0',
        id: '__init__',
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'lobu-test', version: '1.0' },
        },
      },
      token: opts.token,
    });
    const sid = res.headers.get('mcp-session-id');
    if (!sid) throw new Error(`no session id (status ${res.status}): ${await res.text()}`);
    await post(path, {
      body: { jsonrpc: '2.0', method: 'notifications/initialized' },
      headers: { 'mcp-session-id': sid },
      token: opts.token,
    });
    return sid;
  }

  /** Simulate the session fully ageing out: in-memory evicted + persisted row gone. */
  async function expireSessionEverywhere(sessionId: string): Promise<void> {
    clearInMemoryMcpSessionsForTests();
    await getTestDb()`DELETE FROM mcp_sessions WHERE session_id = ${sessionId}`;
  }

  function toolsList(sessionId: string, opts: { token?: string; orgSlug: string }) {
    return post(`/mcp/${opts.orgSlug}`, {
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
      headers: { 'mcp-session-id': sessionId, 'X-MCP-Format': 'json' },
      token: opts.token,
    });
  }

  async function sessionRowExists(sessionId: string): Promise<boolean> {
    const rows = await getTestDb()`SELECT 1 FROM mcp_sessions WHERE session_id = ${sessionId}`;
    return rows.length > 0;
  }

  it('recovers from the persisted row after only the in-memory transport is gone (replica hop)', async () => {
    const { token } = await createTestAccessToken(user.id, org.id, client.client_id);
    const sessionId = await initSession({ token, orgSlug: org.slug });

    // Replica hop: in-memory map cleared, DB row intact (within TTL).
    clearInMemoryMcpSessionsForTests();

    const res = await toolsList(sessionId, { token, orgSlug: org.slug });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.error).toBeUndefined();
    expect(body.result?.tools?.length).toBeGreaterThan(0);
  });

  it('returns 404 (not 200) for an authenticated caller whose session fully expired, and creates no phantom row', async () => {
    const { token } = await createTestAccessToken(user.id, org.id, client.client_id);
    const sessionId = await initSession({ token, orgSlug: org.slug });

    await expireSessionEverywhere(sessionId);

    const res = await toolsList(sessionId, { token, orgSlug: org.slug });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error?.message).toMatch(/expired or not recognized/i);

    // Must NOT re-mint a session under the (now-unverifiable) client-supplied id.
    expect(await sessionRowExists(sessionId)).toBe(false);
  });

  it('returns 404 and creates no row for an authenticated request with a never-issued session id', async () => {
    const { token } = await createTestAccessToken(user.id, org.id, client.client_id);
    const neverIssued = '00000000-0000-4000-8000-000000000000';

    const res = await toolsList(neverIssued, { token, orgSlug: org.slug });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error?.message).toMatch(/expired or not recognized/i);

    expect(await sessionRowExists(neverIssued)).toBe(false);
  });

  it('returns 404 for a GET (SSE reconnect) with a stale session id, consistent with POST', async () => {
    const { token } = await createTestAccessToken(user.id, org.id, client.client_id);
    const sessionId = await initSession({ token, orgSlug: org.slug });
    await expireSessionEverywhere(sessionId);

    const res = await get(`/mcp/${org.slug}`, {
      headers: { 'mcp-session-id': sessionId },
      token,
    });
    expect(res.status).toBe(404);
  });

  it('returns a clear, actionable message (not the old "initialize POST first")', async () => {
    const sessionId = await initSession({ orgSlug: publicOrg.slug });
    await expireSessionEverywhere(sessionId);

    const res = await toolsList(sessionId, { orgSlug: publicOrg.slug });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error?.message).toMatch(/expired or not recognized/i);
    expect(body.error?.message).not.toMatch(/Send an initialize POST first/);
  });
});
