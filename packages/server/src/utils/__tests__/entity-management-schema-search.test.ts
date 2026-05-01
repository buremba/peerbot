/**
 * Schema search path: createEntity falls back to public-catalog orgs when a
 * type slug isn't registered in the entity's own org. Tenant-local types
 * still win when both exist (so user-defined types beat catalog types of the
 * same slug).
 */

import type { EntityLinkRule } from '@lobu/connector-sdk';
import { beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { applyEntityLinks, clearEntityLinkRulesCache } from '../entity-link-upsert';
import { createEntity } from '../entity-management';

async function seedEntityType(orgId: string, slug: string) {
  const sql = getTestDb();
  const rows = await sql<{ id: number }[]>`
    INSERT INTO entity_types (organization_id, slug, name, created_at, updated_at)
    VALUES (${orgId}, ${slug}, ${slug}, current_timestamp, current_timestamp)
    RETURNING id
  `;
  return rows[0].id;
}

describe('entity-management schema search path', () => {
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('resolves an entity_type from a public-catalog org when missing locally', async () => {
    const tenant = await createTestOrganization({ name: 'Tenant Schema Search' });
    const publicCatalog = await createTestOrganization({
      name: 'Public Catalog A',
      visibility: 'public',
    });
    const user = await createTestUser();
    await addUserToOrganization(user.id, tenant.id, 'owner');

    const publicTypeId = await seedEntityType(publicCatalog.id, 'tax_filing');

    const created = await createEntity({
      entity_type: 'tax_filing',
      name: 'Self Assessment 2024-25',
      organization_id: tenant.id,
      created_by: user.id,
    } as Parameters<typeof createEntity>[0]);

    expect(created.entity_type).toBe('tax_filing');

    const sql = getTestDb();
    const rows = await sql<{ entity_type_id: number; organization_id: string }[]>`
      SELECT entity_type_id, organization_id FROM entities WHERE id = ${created.id}
    `;
    // Materialized: the entity row lives in tenant, but its type points at the
    // public-catalog row.
    expect(String(rows[0].organization_id)).toBe(tenant.id);
    expect(Number(rows[0].entity_type_id)).toBe(publicTypeId);
  });

  it('prefers a tenant-local entity_type over a public-catalog one with the same slug', async () => {
    const tenant = await createTestOrganization({ name: 'Tenant Local-Wins' });
    const publicCatalog = await createTestOrganization({
      name: 'Public Catalog B',
      visibility: 'public',
    });
    const user = await createTestUser();
    await addUserToOrganization(user.id, tenant.id, 'owner');

    await seedEntityType(publicCatalog.id, 'tax_filing');
    const tenantTypeId = await seedEntityType(tenant.id, 'tax_filing');

    const created = await createEntity({
      entity_type: 'tax_filing',
      name: 'Local Override',
      organization_id: tenant.id,
      created_by: user.id,
    } as Parameters<typeof createEntity>[0]);

    const sql = getTestDb();
    const rows = await sql<{ entity_type_id: number }[]>`
      SELECT entity_type_id FROM entities WHERE id = ${created.id}
    `;
    expect(Number(rows[0].entity_type_id)).toBe(tenantTypeId);
  });

  it('rejects an unknown entity_type that isn\'t in tenant or any public catalog', async () => {
    const tenant = await createTestOrganization({ name: 'Tenant Unknown-Type' });
    const user = await createTestUser();
    await addUserToOrganization(user.id, tenant.id, 'owner');

    await expect(
      createEntity({
        entity_type: 'never_registered_anywhere',
        name: 'Should Fail',
        organization_id: tenant.id,
        created_by: user.id,
      } as Parameters<typeof createEntity>[0])
    ).rejects.toThrow(/Unknown entity type/i);
  });

  it('does not search private orgs that the caller is not a member of', async () => {
    const tenant = await createTestOrganization({ name: 'Tenant No-Snoop' });
    const otherPrivate = await createTestOrganization({
      name: 'Some Other Private Org',
      visibility: 'private',
    });
    const user = await createTestUser();
    await addUserToOrganization(user.id, tenant.id, 'owner');

    await seedEntityType(otherPrivate.id, 'secret_type');

    await expect(
      createEntity({
        entity_type: 'secret_type',
        name: 'Should Fail',
        organization_id: tenant.id,
        created_by: user.id,
      } as Parameters<typeof createEntity>[0])
    ).rejects.toThrow(/Unknown entity type/i);
  });

  // The same resolver lives in entity-link-upsert.ts (auto-link path). Drift
  // here would be caught by this test.
  it('entity-link-upsert resolves a public-catalog type when no tenant type matches', async () => {
    const tenant = await createTestOrganization({ name: 'Tenant Auto-Link' });
    const publicCatalog = await createTestOrganization({
      name: 'Public Catalog C',
      visibility: 'public',
    });
    const user = await createTestUser();
    await addUserToOrganization(user.id, tenant.id, 'owner');

    const publicTypeId = await seedEntityType(publicCatalog.id, 'public_actor');

    const connectorKey = 'auto-link-cross-org';
    const feedKey = 'msgs';
    const originType = 'msg';
    const rule: EntityLinkRule = {
      entityType: 'public_actor',
      autoCreate: true,
      titlePath: 'metadata.name',
      identities: [{ namespace: 'phone', eventPath: 'metadata.phone' }],
    };
    await createTestConnectorDefinition({
      key: connectorKey,
      name: connectorKey,
      organization_id: tenant.id,
      feeds_schema: {
        [feedKey]: { eventKinds: { [originType]: { entityLinks: [rule] } } },
      },
    });
    clearEntityLinkRulesCache();

    await applyEntityLinks({
      connectorKey,
      feedKey,
      orgId: tenant.id,
      items: [
        { origin_type: originType, metadata: { phone: '14155551234', name: 'Alex' } },
      ],
    });

    const sql = getTestDb();
    const rows = await sql<{ id: number; entity_type_id: number; organization_id: string }[]>`
      SELECT id, entity_type_id, organization_id
      FROM entities
      WHERE organization_id = ${tenant.id} AND name = 'Alex' AND deleted_at IS NULL
    `;
    expect(rows.length).toBe(1);
    expect(Number(rows[0].entity_type_id)).toBe(publicTypeId);
  });
});
