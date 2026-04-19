import { beforeAll, describe, expect, it } from 'vitest';
import { manageEntity } from '../../../tools/admin/manage_entity';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestEntity,
  createTestEvent,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('Entity Deletion History Guards', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let ctx: ToolContext;
  const env = {} as any;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();
    await initWorkspaceProvider();

    org = await createTestOrganization({ name: 'Entity Delete Guard Org' });
    user = await createTestUser({ email: 'entity-delete-guard@test.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const client = await createTestOAuthClient();
    await createTestAccessToken(user.id, org.id, client.client_id);

    ctx = {
      organizationId: org.id,
      userId: user.id,
      isAuthenticated: true,
      clientId: client.client_id,
    } as ToolContext;
  });

  it('blocks hard delete when any descendant has event history', async () => {
    const root = await createTestEntity({
      name: 'Protected Root',
      entity_type: 'brand',
      organization_id: org.id,
    });
    const child = await createTestEntity({
      name: 'Protected Child',
      entity_type: 'brand',
      organization_id: org.id,
      parent_id: root.id,
    });
    const grandchild = await createTestEntity({
      name: 'Protected Grandchild',
      entity_type: 'brand',
      organization_id: org.id,
      parent_id: child.id,
    });

    await createTestEvent({
      entity_id: grandchild.id,
      content: 'Historical knowledge that must be preserved',
      semantic_type: 'content',
      organization_id: org.id,
    });

    await expect(
      manageEntity({ action: 'delete', entity_id: root.id, force_delete_tree: true }, env, ctx)
    ).rejects.toThrow(/preserve event history/i);

    const sql = getTestDb();
    const remaining = await sql`
      SELECT COUNT(*)::int AS count
      FROM entities
      WHERE id = ANY(${`{${root.id},${child.id},${grandchild.id}}`}::bigint[])
        AND deleted_at IS NULL
    `;
    expect(remaining[0].count).toBe(3);
  });

  it('hard deletes the full descendant tree when there is no event history', async () => {
    const root = await createTestEntity({
      name: 'Disposable Root',
      entity_type: 'brand',
      organization_id: org.id,
    });
    const child = await createTestEntity({
      name: 'Disposable Child',
      entity_type: 'brand',
      organization_id: org.id,
      parent_id: root.id,
    });
    const grandchild = await createTestEntity({
      name: 'Disposable Grandchild',
      entity_type: 'brand',
      organization_id: org.id,
      parent_id: child.id,
    });

    const result = await manageEntity(
      { action: 'delete', entity_id: root.id, force_delete_tree: true },
      env,
      ctx
    );

    expect(result.action).toBe('delete');
    if (result.action !== 'delete') {
      throw new Error(`Expected delete result, received ${result.action}`);
    }
    expect(result.deleted_count).toBe(3);

    const sql = getTestDb();
    const remaining = await sql`
      SELECT COUNT(*)::int AS count
      FROM entities
      WHERE id = ANY(${`{${root.id},${child.id},${grandchild.id}}`}::bigint[])
    `;
    expect(remaining[0].count).toBe(0);
  });
});
