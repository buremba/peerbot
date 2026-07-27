/**
 * The follow-up session write must never CREATE a row.
 *
 * The persisted `mcp_sessions` row is the cross-replica revocation signal: a
 * revoke on any pod DELETEs it, and a pod holding a live in-memory transport
 * notices by failing to find it. Checking existence and then upserting is NOT
 * enough — a revoke committing between the check and the write is silently
 * undone by that write, and the session comes back to life on a client whose
 * access was just revoked.
 *
 * `refreshSession` is update-only, so a deleted row stays deleted no matter how
 * the two interleave. These tests pin that at the store, where the ordering can
 * be made deterministic (through HTTP the window is real but not reliably
 * reproducible).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { McpSessionStore, type PersistedMcpSession } from '../../../mcp-session-store';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

describe('mcp session refresh is update-only', () => {
  const store = new McpSessionStore();
  let session: PersistedMcpSession;

  beforeAll(async () => {
    await initWorkspaceProvider();
  });

  beforeEach(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Refresh Org' });
    const user = await createTestUser({ email: 'refresh@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const client = await createTestOAuthClient();

    session = {
      sessionId: 'sess-refresh-1',
      userId: user.id,
      clientId: client.client_id,
      organizationId: org.id,
      memberRole: 'owner',
      requestedAgentId: null,
      isAuthenticated: true,
      scopedToOrg: false,
      lastAccessedAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
    };
  });

  it('refreshes an existing row and reports success', async () => {
    await store.upsertSession(session);

    const bumped = { ...session, lastAccessedAt: session.lastAccessedAt + 60_000 };
    expect(await store.refreshSession(bumped)).toBe(true);

    const row = await store.getSession(session.sessionId);
    expect(row).not.toBeNull();
  });

  it('does NOT resurrect a row deleted by a concurrent revoke', async () => {
    await store.upsertSession(session);

    // Interleave: the revoking replica commits its DELETE while this request is
    // mid-flight, after it already decided the session looked valid.
    await getTestDb()`DELETE FROM mcp_sessions WHERE session_id = ${session.sessionId}`;

    expect(await store.refreshSession(session)).toBe(false);
    expect(await store.getSession(session.sessionId)).toBeNull();

    const rows = await getTestDb()`
      SELECT session_id FROM mcp_sessions WHERE session_id = ${session.sessionId}
    `;
    expect(rows).toHaveLength(0);
  });

  it('upsertSession DOES create — which is why refresh must be used on reuse', async () => {
    // Pins the contrast the fix depends on: the same call the reuse path used
    // to make would have re-INSERTed the revoked row.
    expect(await store.getSession(session.sessionId)).toBeNull();
    await store.upsertSession(session);
    expect(await store.getSession(session.sessionId)).not.toBeNull();
  });
});
