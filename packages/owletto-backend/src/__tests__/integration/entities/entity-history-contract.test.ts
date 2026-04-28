/**
 * Compact entity history contracts kept from the old broad entity suites.
 *
 * These are high-value because they protect auditability and the no-data-loss
 * delete guard: entity updates must emit change events, and deleting a tree
 * must not erase descendants that already have content history.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEvent } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-workspace';

async function waitForChangeEvent(entityId: number) {
  const sql = getTestDb();
  for (let attempt = 0; attempt < 20; attempt++) {
    const rows = await sql`
      SELECT title, metadata, created_by
      FROM events
      WHERE ${entityId} = ANY(entity_ids)
        AND semantic_type = 'change'
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `;
    if (rows.length > 0) return rows[0];
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for change event for entity ${entityId}`);
}

describe('entity history contracts', () => {
  let workspace: TestWorkspace;

  beforeAll(async () => {
    await cleanupTestDatabase();
    workspace = await TestWorkspace.create({ name: 'Entity History Org' });
    await workspace.owner.entity_schema.createType({ slug: 'brand', name: 'Brand' });
  });

  it('records a single change event for real metadata updates, not no-op repeats', async () => {
    const created = (await workspace.owner.entities.create({
      type: 'brand',
      name: 'Audit Brand',
      metadata: { domain: 'old.example' },
    })) as { entity: { id: number } };

    await workspace.owner.entities.update({
      entity_id: created.entity.id,
      metadata: { domain: 'new.example' },
    });

    const event = await waitForChangeEvent(created.entity.id);
    expect(event.created_by).toBe(workspace.users.owner.id);
    expect(String(event.title)).toContain('domain');

    const metadata = event.metadata as { changes?: Array<{ field: string; old: unknown; new: unknown }> };
    expect(metadata.changes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'domain', old: 'old.example', new: 'new.example' }),
      ])
    );

    const before = await getTestDb()`
      SELECT COUNT(*)::int AS count
      FROM events
      WHERE ${created.entity.id} = ANY(entity_ids)
        AND semantic_type = 'change'
    `;
    await workspace.owner.entities.update({
      entity_id: created.entity.id,
      metadata: { domain: 'new.example' },
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const after = await getTestDb()`
      SELECT COUNT(*)::int AS count
      FROM events
      WHERE ${created.entity.id} = ANY(entity_ids)
        AND semantic_type = 'change'
    `;
    expect(after[0].count).toBe(before[0].count);
  });

  it('blocks force-deleting an entity tree when any descendant has event history', async () => {
    const root = (await workspace.owner.entities.create({ type: 'brand', name: 'Protected Root' })) as {
      entity: { id: number };
    };
    const child = (await workspace.owner.entities.create({
      type: 'brand',
      name: 'Protected Child',
      parent_id: root.entity.id,
    })) as { entity: { id: number } };
    const grandchild = (await workspace.owner.entities.create({
      type: 'brand',
      name: 'Protected Grandchild',
      parent_id: child.entity.id,
    })) as { entity: { id: number } };

    await createTestEvent({
      entity_id: grandchild.entity.id,
      organization_id: workspace.org.id,
      content: 'Historical knowledge that must be preserved',
    });

    await expect(
      workspace.owner.entities.delete(root.entity.id, { force_delete_tree: true })
    ).rejects.toThrow(/preserve event history/i);

    const remaining = await getTestDb()`
      SELECT COUNT(*)::int AS count
      FROM entities
      WHERE id = ANY(${`{${root.entity.id},${child.entity.id},${grandchild.entity.id}}`}::bigint[])
        AND deleted_at IS NULL
    `;
    expect(remaining[0].count).toBe(3);
  });

  it('hard-deletes a descendant tree with no event history', async () => {
    const root = (await workspace.owner.entities.create({ type: 'brand', name: 'Disposable Root' })) as {
      entity: { id: number };
    };
    const child = (await workspace.owner.entities.create({
      type: 'brand',
      name: 'Disposable Child',
      parent_id: root.entity.id,
    })) as { entity: { id: number } };
    const grandchild = (await workspace.owner.entities.create({
      type: 'brand',
      name: 'Disposable Grandchild',
      parent_id: child.entity.id,
    })) as { entity: { id: number } };

    const result = (await workspace.owner.entities.delete(root.entity.id, {
      force_delete_tree: true,
    })) as { action: string; deleted_count?: number };
    expect(result.action).toBe('delete');
    expect(result.deleted_count).toBe(3);

    const remaining = await getTestDb()`
      SELECT COUNT(*)::int AS count
      FROM entities
      WHERE id = ANY(${`{${root.entity.id},${child.entity.id},${grandchild.entity.id}}`}::bigint[])
    `;
    expect(remaining[0].count).toBe(0);
  });
});
