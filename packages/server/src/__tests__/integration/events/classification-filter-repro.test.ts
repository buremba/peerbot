import { beforeAll, describe, expect, it } from 'vitest';
import { getContent } from '../../../tools/get_content';
import type { ToolContext } from '../../../tools/registry';
import { initWorkspaceProvider } from '../../../workspace';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestEvent,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';

describe('#2214 classification_filters', () => {
  let ctx: ToolContext;
  let expectedEventIds: number[];

  beforeAll(async () => {
    await initWorkspaceProvider();
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    const org = await createTestOrganization({ name: 'Classification Filter Org' });
    const otherOrg = await createTestOrganization({ name: 'Classification Filter Other Org' });
    const user = await createTestUser({ email: 'cls-repro@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const otherUser = await createTestUser({ email: 'cls-repro-other@example.com' });
    await addUserToOrganization(otherUser.id, otherOrg.id, 'owner');

    const sql = getTestDb();
    const entity = await createTestEntity({
      name: 'Classification Filter Entity',
      organization_id: org.id,
    });
    const otherEntity = await createTestEntity({
      name: 'Classification Filter Other Entity',
      organization_id: otherOrg.id,
    });
    await createTestConnectorDefinition({
      key: 'classification-filter-test',
      name: 'Classification Filter Test',
      organization_id: org.id,
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'classification-filter-test',
      entity_ids: [entity.id],
    });

    const [directOrgEvent] = await sql<{ id: number }[]>`
      INSERT INTO events (organization_id, origin_id, title, payload_type, payload_text,
                          semantic_type, occurred_at, created_at)
      VALUES (${org.id}, 'cls-repro-direct', 'direct org row', 'text', 'direct org row',
              'audit', NOW(), NOW())
      RETURNING id
    `;
    const entityBridgeEvent = await createTestEvent({
      organization_id: otherOrg.id,
      entity_id: entity.id,
      origin_id: 'cls-repro-entity',
      title: 'entity bridge row',
      content: 'entity bridge row',
    });
    const connectionBridgeEvent = await createTestEvent({
      organization_id: otherOrg.id,
      connection_id: connection.id,
      entity_ids: [],
      origin_id: 'cls-repro-connection',
      title: 'connection bridge row',
      content: 'connection bridge row',
    });
    const foreignEvent = await createTestEvent({
      organization_id: otherOrg.id,
      entity_id: otherEntity.id,
      origin_id: 'cls-repro-foreign',
      title: 'foreign row',
      content: 'foreign row',
    });
    await createTestEvent({
      organization_id: org.id,
      entity_ids: [],
      origin_id: 'cls-repro-unclassified',
      title: 'unclassified row',
      content: 'unclassified row',
    });

    const [facet] = await sql<{ id: number }[]>`
      INSERT INTO classify_facet (organization_id, slug, name, attribute_key, status,
                                  created_by, entity_ids, attribute_values, min_similarity)
      VALUES (${org.id}, 'repro-kind', 'Repro kind', 'repro_kind', 'active', ${user.id},
              ARRAY[]::bigint[], ${sql.json({ alpha: { description: 'A', examples: [] } })}, 0.7)
      RETURNING id
    `;
    const facetId = facet.id;

    expectedEventIds = [
      directOrgEvent.id,
      entityBridgeEvent.id,
      connectionBridgeEvent.id,
    ];
    for (const eventId of [...expectedEventIds, foreignEvent.id]) {
      await sql`
        INSERT INTO event_classifications (event_id, classifier_id, watcher_id, window_id,
                                           "values", confidences, source, is_manual)
        VALUES (${eventId}, ${facetId}, NULL, NULL, ${'{alpha}'}::text[],
                ${sql.json({ alpha: 1 })}, 'user', true)
      `;
    }

    ctx = {
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
      isAuthenticated: true,
      tokenType: 'oauth',
      scopedToOrg: false,
      allowCrossOrg: true,
      scopes: ['mcp:read'],
    } as ToolContext;
  });

  it('applies classification filters across every organization-scope path', async () => {
    const result = await getContent(
      { classification_filters: { 'repro-kind': ['alpha'] }, limit: 100 } as never,
      {} as never,
      ctx
    );
    const ids = result.content.map((item) => Number(item.id)).sort((a, b) => a - b);
    expect(ids).toEqual([...expectedEventIds].sort((a, b) => a - b));
    expect(result.total).toBe(expectedEventIds.length);
  });

  it('a value with no matching classification returns nothing', async () => {
    const result = await getContent(
      { classification_filters: { 'repro-kind': ['beta'] }, limit: 100 } as never,
      {} as never,
      ctx
    );
    expect(result.content).toEqual([]);
    expect(result.total).toBe(0);
  });
});
