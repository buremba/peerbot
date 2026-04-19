/**
 * Integration test: content-distribution resolves events via entity_identities.
 *
 * Proves `entityLinkMatchSql` (used by src/index.ts handleContentDistribution
 * and several other content-count sites) matches events two ways:
 *   1. Legacy: event.entity_ids contains the target entity id
 *   2. Identity: event.metadata[namespace] = a live entity_identities row
 *
 * Without the identity branch, historically ingested events (or events from
 * connectors that stamp only namespace keys, not entity_ids) would be
 * invisible to entity-scoped queries.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestEvent,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { get } from '../../setup/test-helpers';

describe('content-distribution > entity identity links', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let token: string;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let otherEntity: Awaited<ReturnType<typeof createTestEntity>>;
  let connection: Awaited<ReturnType<typeof createTestConnection>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Identity Links Org' });
    const user = await createTestUser({ email: 'identity-links-test@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const client = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, org.id, client.client_id)).token;

    entity = await createTestEntity({ name: 'Alice', organization_id: org.id });
    otherEntity = await createTestEntity({ name: 'Bob', organization_id: org.id });

    await createTestConnectorDefinition({
      key: 'identity-link-test-connector',
      name: 'Identity Link Test',
      organization_id: org.id,
    });

    connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'identity-link-test-connector',
      entity_ids: [entity.id],
    });

    const sql = getTestDb();

    // Live identity claim: Alice owns alice@example.com
    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
      VALUES (${org.id}, ${entity.id}, 'email', 'alice@example.com')
    `;

    // Event 1 — legacy attribution: entity_ids array contains Alice.
    await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      content: 'Alice legacy-attributed event.',
      occurred_at: new Date('2025-06-01T10:00:00Z'),
      organization_id: org.id,
    });

    // Event 2 — identity attribution: entity_ids is empty, but metadata.email
    // matches the live entity_identities claim for Alice.
    await createTestEvent({
      entity_ids: [],
      connection_id: connection.id,
      content: 'Alice identity-attributed event.',
      occurred_at: new Date('2025-06-02T10:00:00Z'),
      organization_id: org.id,
      metadata: { email: 'alice@example.com' },
    });

    // Event 3 — unrelated email: should NOT surface under Alice.
    await createTestEvent({
      entity_ids: [],
      connection_id: connection.id,
      content: 'Someone else event.',
      occurred_at: new Date('2025-06-03T10:00:00Z'),
      organization_id: org.id,
      metadata: { email: 'carol@example.com' },
    });

    // Event 4 — Bob's entity_ids: sanity check org scoping holds.
    await createTestEvent({
      entity_id: otherEntity.id,
      connection_id: connection.id,
      content: 'Bob event, not Alice.',
      occurred_at: new Date('2025-06-04T10:00:00Z'),
      organization_id: org.id,
    });
  });

  it('counts events linked via entity_ids array AND entity_identities metadata match', async () => {
    const response = await get(`/api/${org.slug}/entities/${entity.id}/content-distribution`, {
      token,
    });
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      distribution: Array<{ date: string; count: number }>;
    };

    // Alice should have two events: the legacy one (entity_ids) and the
    // identity-linked one (metadata.email via entity_identities).
    const byDate = Object.fromEntries(body.distribution.map((r) => [r.date, r.count]));
    expect(byDate['2025-06-01']).toBe(1);
    expect(byDate['2025-06-02']).toBe(1);
    // Carol's email and Bob's entity_ids must NOT surface for Alice.
    expect(byDate['2025-06-03']).toBeUndefined();
    expect(byDate['2025-06-04']).toBeUndefined();

    const total = body.distribution.reduce((sum, r) => sum + r.count, 0);
    expect(total).toBe(2);
  });

  it('soft-deleted identity links no longer match events', async () => {
    const sql = getTestDb();
    await sql`
      UPDATE entity_identities
      SET deleted_at = NOW()
      WHERE organization_id = ${org.id}
        AND entity_id = ${entity.id}
        AND namespace = 'email'
        AND identifier = 'alice@example.com'
    `;

    try {
      const response = await get(`/api/${org.slug}/entities/${entity.id}/content-distribution`, {
        token,
      });
      expect(response.status).toBe(200);

      const body = (await response.json()) as {
        distribution: Array<{ date: string; count: number }>;
      };
      const total = body.distribution.reduce((sum, r) => sum + r.count, 0);
      // Only the legacy entity_ids event remains — the metadata.email event
      // is no longer linked because the identity row is soft-deleted.
      expect(total).toBe(1);
      expect(body.distribution[0]?.date).toBe('2025-06-01');
    } finally {
      // Restore for any subsequent tests
      await sql`
        UPDATE entity_identities
        SET deleted_at = NULL
        WHERE organization_id = ${org.id}
          AND entity_id = ${entity.id}
          AND namespace = 'email'
          AND identifier = 'alice@example.com'
      `;
    }
  });
});
