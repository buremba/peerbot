/**
 * Reproduction: save_memory from a worker/behavior-window session.
 *
 * Worker direct-auth (workspace/multi-tenant.ts) sets
 * `clientId: 'lobu-worker'` — a synthetic id with no oauth_clients row. If a
 * tool passes that to `events.client_id` unconditionally, the insert trips
 * `events_client_id_fkey`. This reproduces the save_memory failure the
 * voice-profile Behavior hit live ("persistent 'events_client_id_fkey'
 * foreign key constraint"), and proves the fix keeps worker saves working.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../tools/registry';
import { saveContent } from '../../../tools/save_content';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('saveContent > worker/behavior-window session (synthetic client id)', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  const sql = getTestDb();

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    org = await createTestOrganization({ name: 'Worker Save Org' });
    user = await createTestUser({ email: 'worker-save@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
  });

  function workerCtx(): ToolContext {
    return {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'pat',
      clientId: 'lobu-worker',
      scopedToOrg: false,
      allowCrossOrg: false,
      scopes: ['mcp:read', 'mcp:write', 'mcp:admin'],
      sourceContext: null,
    } as ToolContext;
  }

  it('saves cleanly from a worker session (no events_client_id_fkey)', async () => {
    const result = await saveContent(
      {
        content: 'A memory saved from a behavior-window worker session.',
        semantic_type: 'note',
        title: 'worker-session note',
        metadata: {},
      } as never,
      {} as never,
      workerCtx()
    );
    expect(result.id).toBeTruthy();
    expect(result.durable_at).toBeTruthy();

    // The row must have a NULL client_id (the synthetic 'lobu-worker' has no
    // oauth_clients row and must never be stored on events).
    const [row] = await sql<{ client_id: string | null }>`
      SELECT client_id FROM events WHERE id = ${result.id}
    `;
    expect(row.client_id).toBeNull();
  });

  it('supersedes cleanly from a worker session (supersede runs inside a tx)', async () => {
    // The voice-profile behavior refines profiles with `supersedes_event_id`,
    // which routes insertEvent through `sql.begin`. The FK retry must not
    // abort that transaction — this is the exact failure the behavior hit
    // live ("persistent 'events_client_id_fkey' constraint ... errors").
    const first = (await saveContent(
      {
        content: 'worker profile v1',
        semantic_type: 'note',
        title: 'worker-supersede v1',
        metadata: {},
      } as never,
      {} as never,
      workerCtx()
    )) as { id: number };
    const second = (await saveContent(
      {
        content: 'worker profile v2',
        semantic_type: 'note',
        title: 'worker-supersede v2',
        metadata: {},
        supersedes_event_id: first.id,
      } as never,
      {} as never,
      workerCtx()
    )) as { id: number };
    expect(second.id).toBeGreaterThan(first.id);

    const rows = await sql<{ id: number; client_id: string | null }>`
      SELECT id, client_id FROM events WHERE id IN (${first.id}, ${second.id}) ORDER BY id
    `;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.client_id === null)).toBe(true);
  });
});
