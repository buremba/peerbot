/**
 * Integration: manage_view_templates `clear` nulls the entity type's default
 * template pointer (current_view_template_version_id) so the detail page falls
 * back to the schema-derived auto-default. This is the prune-gated removal path
 * `lobu apply` uses. Append-only — the version history rows are kept.
 *
 * DB-backed (real entity_types + view_template_versions); runs against the
 * pgvector DB via DATABASE_URL.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { manageViewTemplates } from '../../../tools/admin/manage_view_templates';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

describe('manage_view_templates clear', () => {
  let ctx: ToolContext;
  let entityTypeId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'View Template Clear Org' });
    const user = await createTestUser({ email: 'view-clear@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const sql = getTestDb();
    const [et] = await sql`
      INSERT INTO entity_types (organization_id, slug, name, created_by, created_at, updated_at)
      VALUES (${org.id}, 'deal', 'Deal', ${user.id}, NOW(), NOW())
      RETURNING id
    `;
    entityTypeId = Number(et.id);
    ctx = {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:admin'],
    } as ToolContext;
  });

  async function currentVersionId(): Promise<number | null> {
    const sql = getTestDb();
    const [row] = await sql`
      SELECT current_view_template_version_id FROM entity_types WHERE id = ${entityTypeId}
    `;
    const v = row?.current_view_template_version_id;
    return v == null ? null : Number(v);
  }

  it('set points the type at a version, clear nulls it (history retained)', async () => {
    await manageViewTemplates(
      {
        action: 'set',
        resource_type: 'entity_type',
        resource_id: 'deal',
        json_template: { type: 'card', children: [] },
      } as never,
      {} as never,
      ctx
    );
    expect(await currentVersionId()).not.toBeNull();

    const result = (await manageViewTemplates(
      { action: 'clear', resource_type: 'entity_type', resource_id: 'deal' } as never,
      {} as never,
      ctx
    )) as { action: string; success: boolean };
    expect(result.action).toBe('clear');
    expect(result.success).toBe(true);
    expect(await currentVersionId()).toBeNull();

    // History row is retained (append-only) so a later rollback can restore.
    const sql = getTestDb();
    const history = await sql`
      SELECT COUNT(*)::int AS n FROM view_template_versions
      WHERE resource_type = 'entity_type' AND resource_id = 'deal'
        AND organization_id = ${ctx.organizationId} AND tab_name IS NULL
    `;
    expect(Number(history[0].n)).toBeGreaterThan(0);
  });

  it('clear is idempotent when there is no default template', async () => {
    const result = (await manageViewTemplates(
      { action: 'clear', resource_type: 'entity_type', resource_id: 'deal' } as never,
      {} as never,
      ctx
    )) as { success: boolean };
    expect(result.success).toBe(true);
    expect(await currentVersionId()).toBeNull();
  });
});
