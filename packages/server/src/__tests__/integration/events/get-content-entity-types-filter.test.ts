/**
 * Integration test: org-wide `entity_types` filter on read_knowledge listings.
 *
 * Memory page sends `entity_types` without `entity_id`. The filter should keep
 * only events whose `entity_ids` overlap entities whose type slug is selected.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('getContent > org-wide entity_types filter', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let personEntity: Awaited<ReturnType<typeof createTestEntity>>;
  let companyEntity: Awaited<ReturnType<typeof createTestEntity>>;
  let personEventId: number;
  let companyEventId: number;
  let unlinkedEventId: number;

  function authedCtx(): ToolContext {
    return {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    };
  }

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Entity Types Filter Org' });
    user = await createTestUser({ email: 'entity-types-filter@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    personEntity = await createTestEntity({
      name: 'Alice',
      entity_type: 'person',
      organization_id: org.id,
    });
    companyEntity = await createTestEntity({
      name: 'Acme Corp',
      entity_type: 'company',
      organization_id: org.id,
    });

    personEventId = (
      await createTestEvent({
        entity_ids: [personEntity.id],
        content: 'Person-linked event',
        organization_id: org.id,
      })
    ).id;
    companyEventId = (
      await createTestEvent({
        entity_ids: [companyEntity.id],
        content: 'Company-linked event',
        organization_id: org.id,
      })
    ).id;
    unlinkedEventId = (
      await createTestEvent({
        entity_ids: [],
        content: 'Unlinked org event',
        organization_id: org.id,
      })
    ).id;
  });

  it('returns only events linked to entities of the selected type slugs', async () => {
    const result = await getContent(
      {
        entity_types: ['person'],
        sort_by: 'date',
        sort_order: 'desc',
        limit: 50,
      },
      {} as never,
      authedCtx()
    );

    const ids = result.content.map((row) => row.id);
    expect(ids).toContain(personEventId);
    expect(ids).not.toContain(companyEventId);
    expect(ids).not.toContain(unlinkedEventId);
  });

  it('matches any of multiple selected entity type slugs', async () => {
    const result = await getContent(
      {
        entity_types: ['person', 'company'],
        sort_by: 'date',
        sort_order: 'desc',
        limit: 50,
      },
      {} as never,
      authedCtx()
    );

    const ids = result.content.map((row) => row.id);
    expect(ids).toContain(personEventId);
    expect(ids).toContain(companyEventId);
    expect(ids).not.toContain(unlinkedEventId);
  });

  it('ignores entity_types when entity_id is set (entity-scoped mode)', async () => {
    const result = await getContent(
      {
        entity_id: companyEntity.id,
        entity_types: ['person'],
        sort_by: 'date',
        sort_order: 'desc',
        limit: 50,
      },
      {} as never,
      authedCtx()
    );

    const ids = result.content.map((row) => row.id);
    expect(ids).toContain(companyEventId);
    expect(ids).not.toContain(personEventId);
  });
});