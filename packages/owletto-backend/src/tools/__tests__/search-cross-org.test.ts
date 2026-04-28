/**
 * Search tool surfaces public-catalog entities so tenant agents can discover
 * canonical entities (HMRC, banks, currencies) without knowing their IDs
 * upfront. Caller's-org entities still come back; public ones are added when
 * the include_public_catalogs flag is on (default).
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupTestDatabase } from '../../__tests__/setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestOrganization,
  createTestUser,
} from '../../__tests__/setup/test-fixtures';
import { initWorkspaceProvider } from '../../workspace';
import { search } from '../search';

describe('search cross-org public catalog discovery', () => {
  beforeAll(async () => {
    // search() walks workspace metadata to attach org slugs.
    await initWorkspaceProvider();
  });
  beforeEach(async () => {
    await cleanupTestDatabase();
  });

  it('returns matching entities from public-catalog orgs alongside tenant hits', async () => {
    const tenant = await createTestOrganization({ name: 'Tenant Search' });
    const publicCatalog = await createTestOrganization({
      name: 'Public Catalog Search',
      visibility: 'public',
    });
    const user = await createTestUser();
    await addUserToOrganization(user.id, tenant.id, 'owner');

    const tenantEntity = await createTestEntity({
      name: 'Apple Local',
      entity_type: 'brand',
      organization_id: tenant.id,
    });
    const publicEntity = await createTestEntity({
      name: 'Apple Inc',
      entity_type: 'brand',
      organization_id: publicCatalog.id,
    });

    const result = await search(
      { query: 'Apple', fuzzy: true, include_content: false },
      {} as Parameters<typeof search>[1],
      { organizationId: tenant.id, userId: user.id } as Parameters<typeof search>[2]
    );

    const ids = result.matches.map((e: { id: number }) => e.id);
    expect(ids).toContain(tenantEntity.id);
    expect(ids).toContain(publicEntity.id);
  });

  it('omits public-catalog hits when include_public_catalogs=false', async () => {
    const tenant = await createTestOrganization({ name: 'Tenant Local-Only' });
    const publicCatalog = await createTestOrganization({
      name: 'Public Catalog Local-Only',
      visibility: 'public',
    });
    const user = await createTestUser();
    await addUserToOrganization(user.id, tenant.id, 'owner');

    await createTestEntity({
      name: 'Local Apple',
      entity_type: 'brand',
      organization_id: tenant.id,
    });
    const publicEntity = await createTestEntity({
      name: 'Public Apple',
      entity_type: 'brand',
      organization_id: publicCatalog.id,
    });

    const result = await search(
      {
        query: 'Apple',
        fuzzy: true,
        include_content: false,
        include_public_catalogs: false,
      },
      {} as Parameters<typeof search>[1],
      { organizationId: tenant.id, userId: user.id } as Parameters<typeof search>[2]
    );

    const ids = result.matches.map((e: { id: number }) => e.id);
    expect(ids).not.toContain(publicEntity.id);
  });

  it('does not surface entities from private orgs the caller is not in', async () => {
    const tenant = await createTestOrganization({ name: 'Tenant No-Snoop Search' });
    const otherPrivate = await createTestOrganization({
      name: 'Some Other Private',
      visibility: 'private',
    });
    const user = await createTestUser();
    await addUserToOrganization(user.id, tenant.id, 'owner');

    const privateEntity = await createTestEntity({
      name: 'Hidden Apple',
      entity_type: 'brand',
      organization_id: otherPrivate.id,
    });

    const result = await search(
      { query: 'Apple', fuzzy: true, include_content: false, include_public_catalogs: true },
      {} as Parameters<typeof search>[1],
      { organizationId: tenant.id, userId: user.id } as Parameters<typeof search>[2]
    );

    const ids = result.matches.map((e: { id: number }) => e.id);
    expect(ids).not.toContain(privateEntity.id);
  });
});
