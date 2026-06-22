/**
 * Render-store consolidation, expand phase: view_template_versions.is_current is
 * maintained by a DB trigger on view_template_active_tabs (the app still writes
 * only active_tabs). Asserts is_current stays in lockstep with active_tabs across
 * set / rollback / re-point / remove_tab, and that at most one version per
 * (resource, tab) is current (the partial unique index invariant). Reads still
 * use active_tabs this phase; the flip + table drop are later releases.
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

async function currentIds(tabName: string): Promise<number[]> {
  const rows = (await sql`
    SELECT id FROM view_template_versions
    WHERE resource_type = 'entity_type' AND resource_id = 'company'
      AND tab_name = ${tabName} AND is_current = true
    ORDER BY id
  `) as Array<{ id: string }>;
  return rows.map((r) => Number(r.id));
}

async function activeTabId(tabName: string): Promise<number | null> {
  const rows = (await sql`
    SELECT current_version_id FROM view_template_active_tabs
    WHERE resource_type = 'entity_type' AND resource_id = 'company' AND tab_name = ${tabName}
  `) as Array<{ current_version_id: string }>;
  return rows.length ? Number(rows[0].current_version_id) : null;
}

describe('view_template is_current via trigger (expand phase)', () => {
  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'VT Org' });
    const u = await createTestUser({ email: 'vt-owner@test.com' });
    await addUserToOrganization(u.id, org.id, 'owner');
    owner = await TestApiClient.for({ organizationId: org.id, userId: u.id, memberRole: 'owner' });
    await owner.entity_schema.createType({ slug: 'company', name: 'Company' });
  });

  it('set marks exactly one is_current, matching active_tabs, and advances on re-set', async () => {
    await owner.view_templates.set({
      resource_type: 'entity_type',
      resource_id: 'company',
      tab_name: 'analytics',
      json_template: tmpl(1),
    });
    const cur1 = await currentIds('analytics');
    expect(cur1).toHaveLength(1);
    expect(cur1[0]).toBe(await activeTabId('analytics'));

    await owner.view_templates.set({
      resource_type: 'entity_type',
      resource_id: 'company',
      tab_name: 'analytics',
      json_template: tmpl(2),
    });
    const cur2 = await currentIds('analytics');
    expect(cur2).toHaveLength(1); // still exactly one current (unique invariant)
    expect(cur2[0]).toBe(await activeTabId('analytics'));
    expect(cur2[0]).toBeGreaterThan(cur1[0]); // advanced to the new version
  });

  it('rollback moves is_current back, in sync with active_tabs', async () => {
    await owner.view_templates.rollback({
      resource_type: 'entity_type',
      resource_id: 'company',
      tab_name: 'analytics',
      version: 1,
    });
    const cur = await currentIds('analytics');
    expect(cur).toHaveLength(1);
    expect(cur[0]).toBe(await activeTabId('analytics'));
  });

  it('re-pointing to the already-current version is a no-op (still exactly one current)', async () => {
    // After the rollback above, v1 is current. Roll back to v1 again — the
    // trigger fires with current_version_id unchanged and must not error or
    // produce zero/two current rows.
    const before = await currentIds('analytics');
    expect(before).toHaveLength(1);
    await owner.view_templates.rollback({
      resource_type: 'entity_type',
      resource_id: 'company',
      tab_name: 'analytics',
      version: 1,
    });
    const after = await currentIds('analytics');
    expect(after).toEqual(before); // same single current id, no change
    expect(after[0]).toBe(await activeTabId('analytics'));
  });

  it('remove_tab clears is_current (matching the active_tabs delete)', async () => {
    await owner.view_templates.removeTab({
      resource_type: 'entity_type',
      resource_id: 'company',
      tab_name: 'analytics',
    });
    expect(await currentIds('analytics')).toHaveLength(0);
    expect(await activeTabId('analytics')).toBeNull();
  });
});
