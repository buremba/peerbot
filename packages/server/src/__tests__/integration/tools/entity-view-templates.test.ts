import { beforeEach, describe, expect, it } from 'vitest';
import { manageViewTemplates } from '../../../tools/admin/manage_view_templates';
import type { ToolContext } from '../../../tools/registry';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';

async function seedEntityViewTarget() {
  const organization = await createTestOrganization({ name: 'Entity view template org' });
  const user = await createTestUser({ email: 'entity-view-template@example.com' });
  await addUserToOrganization(user.id, organization.id, 'owner');
  const entity = await createTestEntity({
    organization_id: organization.id,
    entity_type: 'deal',
    name: 'Template target',
    created_by: user.id,
  });
  const ctx = {
    organizationId: organization.id,
    userId: user.id,
    memberRole: 'owner',
    isAuthenticated: true,
    tokenType: 'oauth',
    scopedToOrg: false,
    allowCrossOrg: true,
    scopes: ['mcp:admin'],
  } as ToolContext;
  return { organization, entity, ctx };
}

async function currentVersionId(entityId: number): Promise<number | null> {
  const sql = getTestDb();
  const [row] = await sql`
    SELECT current_view_template_version_id
    FROM entities
    WHERE id = ${entityId}
  `;
  const value = row?.current_view_template_version_id;
  return value == null ? null : Number(value);
}

describe('entity-scoped view templates', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('sets, rolls back, and clears the entity pointer through the write kernel', async () => {
    const { entity, ctx } = await seedEntityViewTarget();
    const first = (await manageViewTemplates(
      {
        action: 'set',
        resource_type: 'entity',
        resource_id: entity.id,
        json_template: { type: 'card', children: [] },
      } as never,
      {} as never,
      ctx
    )) as { version: { id: number; version: number } };
    expect(await currentVersionId(entity.id)).toBe(first.version.id);

    const second = (await manageViewTemplates(
      {
        action: 'set',
        resource_type: 'entity',
        resource_id: entity.id,
        json_template: { type: 'div', children: [] },
      } as never,
      {} as never,
      ctx
    )) as { version: { id: number; version: number } };
    expect(second.version.id).not.toBe(first.version.id);
    expect(await currentVersionId(entity.id)).toBe(second.version.id);

    await manageViewTemplates(
      {
        action: 'rollback',
        resource_type: 'entity',
        resource_id: entity.id,
        version: first.version.version,
      } as never,
      {} as never,
      ctx
    );
    expect(await currentVersionId(entity.id)).toBe(first.version.id);

    await manageViewTemplates(
      { action: 'clear', resource_type: 'entity', resource_id: entity.id } as never,
      {} as never,
      ctx
    );
    expect(await currentVersionId(entity.id)).toBeNull();

    const sql = getTestDb();
    const [history] = await sql<{ count: number }>`
      SELECT count(*)::int AS count
      FROM view_template_versions
      WHERE resource_type = 'entity'
        AND resource_id = ${String(entity.id)}
        AND organization_id = ${ctx.organizationId}
    `;
    expect(history.count).toBe(2);
  });

  it('does not read or version a soft-deleted entity', async () => {
    const { entity, ctx } = await seedEntityViewTarget();
    const sql = getTestDb();
    await sql`
      UPDATE entities
      SET deleted_at = current_timestamp
      WHERE id = ${entity.id}
    `;

    // A tombstoned entity is gone for reads too, not just for writes.
    await expect(
      manageViewTemplates(
        { action: 'get', resource_type: 'entity', resource_id: entity.id } as never,
        {} as never,
        ctx
      )
    ).rejects.toThrow(`Entity ${entity.id} not found`);

    await expect(
      manageViewTemplates(
        {
          action: 'set',
          resource_type: 'entity',
          resource_id: entity.id,
          json_template: { type: 'card', children: [] },
        } as never,
        {} as never,
        ctx
      )
    ).rejects.toThrow(`Entity ${entity.id} not found`);

    const [history] = await sql<{ count: number }>`
      SELECT count(*)::int AS count
      FROM view_template_versions
      WHERE resource_type = 'entity'
        AND resource_id = ${String(entity.id)}
        AND organization_id = ${ctx.organizationId}
    `;
    expect(history.count).toBe(0);
  });
});
