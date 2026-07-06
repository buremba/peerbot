/**
 * Integration test: save_content (save_memory / client.knowledge.save) stamps
 * `occurred_at` when the caller omits it.
 *
 * The tool schema has always promised "Defaults to now if omitted", but the
 * implementation passed NULL through to insertEvent. A NULL occurred_at makes
 * the event invisible to every watcher window (window content is an events CTE
 * filtered on occurred_at within [window_start, window_end)), so agent-saved
 * knowledge silently never reached watchers.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { ToolContext } from '../../../tools/registry';
import { saveContent } from '../../../tools/save_content';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('saveContent > occurred_at default', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let entityId: number;

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Occurred At Org' });
    user = await createTestUser({ email: 'occurred-at@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const entity = await createTestEntity({
      name: 'Occurred At Entity',
      organization_id: org.id,
    });
    entityId = entity.id;
  });

  function ctx(): ToolContext {
    return {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:write'],
      sourceContext: null,
    } as ToolContext;
  }

  it('defaults occurred_at to now when omitted', async () => {
    const before = Date.now();
    const result = (await saveContent(
      {
        entity_ids: [entityId],
        content: 'A note saved without an explicit occurred_at.',
        semantic_type: 'note',
        metadata: {},
      } as never,
      {} as never,
      ctx()
    )) as { id: number };

    const sql = getTestDb();
    const [row] = await sql`
      SELECT occurred_at FROM events WHERE id = ${result.id}
    `;
    expect(row.occurred_at).not.toBeNull();
    const occurredMs = new Date(row.occurred_at as string).getTime();
    expect(occurredMs).toBeGreaterThanOrEqual(before - 1000);
    expect(occurredMs).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('preserves an explicit occurred_at', async () => {
    const explicit = '2026-01-02T03:04:05.000Z';
    const result = (await saveContent(
      {
        entity_ids: [entityId],
        content: 'A note with an explicit occurred_at.',
        semantic_type: 'note',
        occurred_at: explicit,
        metadata: {},
      } as never,
      {} as never,
      ctx()
    )) as { id: number };

    const sql = getTestDb();
    const [row] = await sql`
      SELECT occurred_at FROM events WHERE id = ${result.id}
    `;
    expect(new Date(row.occurred_at as string).toISOString()).toBe(explicit);
  });
});
