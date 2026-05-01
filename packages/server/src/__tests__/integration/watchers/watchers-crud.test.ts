/**
 * Watcher CRUD via the post-#348 SDK surface.
 *
 * Replaces the deleted manage_watchers integration tests. Covers create,
 * read, update, delete on watchers attached to an entity, plus access-control
 * around the destructive actions.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase } from '../../setup/test-db';

describe('watcher CRUD', () => {
  let owner: TestApiClient;
  let entityId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Watcher Test Org' });
    const user = await createTestUser({ email: 'watcher-owner@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });

    await owner.entity_schema.createType({ slug: 'company', name: 'Company' });
    const entity = (await owner.entities.create({
      type: 'company',
      name: 'Watcher Target',
    })) as { entity: { id: number } };
    entityId = entity.entity.id;
  });

  it('creates → reads back → updates → deletes a watcher', async () => {
    const created = (await owner.watchers.create({
      entity_id: entityId,
      slug: 'lifecycle-watcher',
      name: 'Lifecycle Watcher',
      prompt: 'Track product launches.',
      extraction_schema: {
        type: 'object',
        properties: { launches: { type: 'array', items: { type: 'string' } } },
      },
      schedule: '0 9 * * *',
    })) as { watcher_id: string };
    const watcherId = created.watcher_id;
    expect(watcherId).toBeDefined();

    const got = (await owner.watchers.get(watcherId)) as {
      watcher?: { watcher_name: string };
    };
    expect(got.watcher?.watcher_name).toBe('Lifecycle Watcher');

    await owner.watchers.update({ watcher_id: watcherId, schedule: '0 10 * * *' });
    const after = (await owner.watchers.get(watcherId)) as {
      watcher?: { schedule: string | null };
    };
    expect(after.watcher?.schedule).toBe('0 10 * * *');

    await owner.watchers.delete([watcherId]);
    const list = (await owner.watchers.list({ entity_id: entityId })) as {
      watchers?: Array<{ watcher_id: string }>;
    };
    expect(list.watchers?.some((w) => w.watcher_id === watcherId)).toBe(false);
  });

  it('blocks a member from deleting watchers (admin-only)', async () => {
    const created = (await owner.watchers.create({
      entity_id: entityId,
      slug: 'protected-watcher',
      name: 'Protected',
      prompt: 'guarded.',
      extraction_schema: {
        type: 'object',
        properties: { signal: { type: 'string' } },
      },
    })) as { watcher_id: string };

    const member = owner.withAuth({ memberRole: 'member' });
    await expect(member.watchers.delete([created.watcher_id])).rejects.toThrow(
      /admin|owner|access/i
    );
  });
});
