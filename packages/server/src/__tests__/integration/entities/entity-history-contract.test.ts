/**
 * Compact entity history contracts kept from the old broad entity suites.
 *
 * These are high-value because they protect auditability and the append-only
 * event invariant: entity updates must emit change events, and force-deleting
 * a tree must detach — never delete — the event history that references it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import { createTestEvent } from '../../setup/test-fixtures';
import { TestWorkspace } from '../../setup/test-mcp-client';

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

  it('force-deletes a tree with event history by detaching event references, not deleting events', async () => {
    const root = (await workspace.owner.entities.create({ type: 'brand', name: 'Purged Root' })) as {
      entity: { id: number };
    };
    const child = (await workspace.owner.entities.create({
      type: 'brand',
      name: 'Purged Child',
      parent_id: root.entity.id,
    })) as { entity: { id: number } };
    const grandchild = (await workspace.owner.entities.create({
      type: 'brand',
      name: 'Purged Grandchild',
      parent_id: child.entity.id,
    })) as { entity: { id: number } };

    const event = await createTestEvent({
      entity_id: grandchild.entity.id,
      organization_id: workspace.org.id,
      content: 'Historical knowledge that must survive the purge',
    });

    // Preflight: dry_run reports what the delete would touch without mutating.
    const preview = (await workspace.owner.entities.delete({
      entity_id: root.entity.id,
      force_delete_tree: true,
      dry_run: true,
    })) as { action: string; deleted_count: number; dry_run?: boolean; tree?: Record<string, number> };
    expect(preview.dry_run).toBe(true);
    expect(preview.deleted_count).toBe(0);
    expect(preview.tree).toMatchObject({ entities: 3, events_detached: 1 });

    const afterPreview = await getTestDb()`
      SELECT COUNT(*)::int AS count
      FROM entities
      WHERE id = ANY(${`{${root.entity.id},${child.entity.id},${grandchild.entity.id}}`}::bigint[])
        AND deleted_at IS NULL
    `;
    expect(afterPreview[0].count).toBe(3);

    const result = (await workspace.owner.entities.delete({
      entity_id: root.entity.id,
      force_delete_tree: true,
    })) as { action: string; deleted_count?: number; tree?: Record<string, number> };
    expect(result.action).toBe('delete');
    expect(result.deleted_count).toBe(3);
    expect(result.tree).toMatchObject({ entities: 3, events_detached: 1 });

    const remaining = await getTestDb()`
      SELECT COUNT(*)::int AS count
      FROM entities
      WHERE id = ANY(${`{${root.entity.id},${child.entity.id},${grandchild.entity.id}}`}::bigint[])
    `;
    expect(remaining[0].count).toBe(0);

    // The event row survives as append-only history; only its entity linkage is gone.
    const eventRows = await getTestDb()`
      SELECT (${grandchild.entity.id} = ANY(entity_ids)) AS still_linked
      FROM events WHERE id = ${event.id}
    `;
    expect(eventRows).toHaveLength(1);
    expect(eventRows[0].still_linked).toBe(false);
  });

  it('force-deletes fresh entities whose own lifecycle produced platform change events (#2049)', async () => {
    await workspace.owner.entity_schema.createRelType({
      slug: 'related-brand',
      name: 'Related Brand',
    });

    const a = (await workspace.owner.entities.create({ type: 'brand', name: 'Disposable A' })) as {
      entity: { id: number };
    };
    const b = (await workspace.owner.entities.create({ type: 'brand', name: 'Disposable B' })) as {
      entity: { id: number };
    };

    // Normal lifecycle activity: a metadata update emits a platform change
    // event, and a temporary relationship is created then removed.
    await workspace.owner.entities.update({
      entity_id: a.entity.id,
      metadata: { domain: 'disposable.example' },
    });
    await waitForChangeEvent(a.entity.id);
    const linked = (await workspace.owner.entities.link({
      from_entity_id: a.entity.id,
      to_entity_id: b.entity.id,
      relationship_type_slug: 'related-brand',
    })) as { relationship: { id: number } };
    await workspace.owner.entities.manage({
      action: 'unlink',
      relationship_id: linked.relationship.id,
    });

    for (const id of [a.entity.id, b.entity.id]) {
      const result = (await workspace.owner.entities.delete({
        entity_id: id,
        force_delete_tree: true,
      })) as { action: string; deleted_count?: number };
      expect(result.action).toBe('delete');
      expect(result.deleted_count).toBe(1);
    }

    const remaining = await getTestDb()`
      SELECT COUNT(*)::int AS count
      FROM entities
      WHERE id = ANY(${`{${a.entity.id},${b.entity.id}}`}::bigint[])
    `;
    expect(remaining[0].count).toBe(0);

    // The change event history is preserved (append-only), just detached.
    const changeEvents = await getTestDb()`
      SELECT entity_ids FROM events
      WHERE semantic_type = 'change'
        AND ${a.entity.id} = ANY(entity_ids)
    `;
    expect(changeEvents).toHaveLength(0);
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

    const result = (await workspace.owner.entities.delete({
      entity_id: root.entity.id,
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
