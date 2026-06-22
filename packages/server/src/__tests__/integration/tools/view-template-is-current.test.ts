/**
 * Render-store consolidation phase 3b: manage_view_templates maintains
 * view_template_versions.is_current + tab_order DIRECTLY (the
 * view_template_active_tabs pointer table and its sync trigger are retired; reads
 * already use is_current). Asserts is_current is correct on its own across
 * set / re-set / rollback / re-point / remove_tab, with exactly one current
 * version per named tab (the partial unique index invariant), and that get()
 * surfaces named tabs from is_current.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';

const sql = getTestDb();
let owner: TestApiClient;

const tmpl = (n: number) => ({ version: 1, root: { type: 'text', content: `v${n}` } });

async function current(tabName: string): Promise<Array<{ id: number; order: number }>> {
  const rows = (await sql`
    SELECT id, tab_order FROM view_template_versions
    WHERE resource_type = 'entity_type' AND resource_id = 'company'
      AND tab_name = ${tabName} AND is_current = true
    ORDER BY id
  `) as Array<{ id: string; tab_order: number }>;
  return rows.map((r) => ({ id: Number(r.id), order: Number(r.tab_order) }));
}

describe('view_template is_current direct (phase 3b — active_tabs + trigger retired)', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'VT Org' });
    const u = await createTestUser({ email: 'vt-owner@test.com' });
    await addUserToOrganization(u.id, org.id, 'owner');
    owner = await TestApiClient.for({ organizationId: org.id, userId: u.id, memberRole: 'owner' });
    await owner.entity_schema.createType({ slug: 'company', name: 'Company' });
  });

  it('set marks exactly one current and advances on re-set', async () => {
    await owner.view_templates.set({
      resource_type: 'entity_type',
      resource_id: 'company',
      tab_name: 'analytics',
      tab_order: 2,
      json_template: tmpl(1),
    });
    const c1 = await current('analytics');
    expect(c1).toHaveLength(1);
    expect(c1[0].order).toBe(2);

    await owner.view_templates.set({
      resource_type: 'entity_type',
      resource_id: 'company',
      tab_name: 'analytics',
      tab_order: 5,
      json_template: tmpl(2),
    });
    const c2 = await current('analytics');
    expect(c2).toHaveLength(1);
    expect(c2[0].id).toBeGreaterThan(c1[0].id);
    expect(c2[0].order).toBe(5);
  });

  it('rollback re-points and preserves the tab display order', async () => {
    // current is v2 @ order 5; rollback to v1 must keep order 5.
    await owner.view_templates.rollback({
      resource_type: 'entity_type',
      resource_id: 'company',
      tab_name: 'analytics',
      version: 1,
    });
    const c = await current('analytics');
    expect(c).toHaveLength(1);
    expect(c[0].order).toBe(5);
  });

  it('re-pointing to the already-current version is a no-op', async () => {
    const before = await current('analytics');
    await owner.view_templates.rollback({
      resource_type: 'entity_type',
      resource_id: 'company',
      tab_name: 'analytics',
      version: 1,
    });
    expect(await current('analytics')).toEqual(before);
  });

  it('get() surfaces the named tab from is_current', async () => {
    const res = (await owner.view_templates.get({
      resource_type: 'entity_type',
      resource_id: 'company',
    })) as { tabs: Array<{ tab_name: string; current_version_id: number }> };
    const analytics = res.tabs.find((t) => t.tab_name === 'analytics');
    expect(analytics).toBeDefined();
    expect(analytics!.current_version_id).toBe((await current('analytics'))[0].id);
  });

  it('concurrent same-tab sets serialize on the advisory lock (no unique-violation 500)', async () => {
    // Without the per-tab advisory lock these would race on clear-then-set and one
    // could 500 on the partial unique index. They must all succeed, leaving exactly
    // one current version.
    await Promise.all([
      owner.view_templates.set({
        resource_type: 'entity_type',
        resource_id: 'company',
        tab_name: 'race',
        tab_order: 1,
        json_template: tmpl(1),
      }),
      owner.view_templates.set({
        resource_type: 'entity_type',
        resource_id: 'company',
        tab_name: 'race',
        tab_order: 1,
        json_template: tmpl(2),
      }),
      owner.view_templates.set({
        resource_type: 'entity_type',
        resource_id: 'company',
        tab_name: 'race',
        tab_order: 1,
        json_template: tmpl(3),
      }),
    ]);
    expect(await current('race')).toHaveLength(1);
  });

  it('remove_tab clears is_current; rollback on a missing tab errors', async () => {
    await owner.view_templates.removeTab({
      resource_type: 'entity_type',
      resource_id: 'company',
      tab_name: 'analytics',
    });
    expect(await current('analytics')).toHaveLength(0);

    await expect(
      owner.view_templates.rollback({
        resource_type: 'entity_type',
        resource_id: 'company',
        tab_name: 'analytics',
        version: 1,
      })
    ).rejects.toThrow(/no active entry/i);
  });
});
