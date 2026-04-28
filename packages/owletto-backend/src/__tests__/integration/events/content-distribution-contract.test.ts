/**
 * Compact content-distribution contracts.
 *
 * High-value coverage retained from the deleted timeline suites: entity-scoped
 * distribution must include legacy entity_ids matches, metadata identity-link
 * matches, and undated rows via created_at fallback without leaking unrelated
 * entities/identities.
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
} from '../../setup/test-fixtures';
import { get } from '../../setup/test-helpers';

describe('content-distribution contract', () => {
  let orgSlug: string;
  let orgId: string;
  let token: string;
  let entityId: number;

  beforeAll(async () => {
    await cleanupTestDatabase();
    const sql = getTestDb();

    const org = await createTestOrganization({ name: 'Distribution Contract Org' });
    orgSlug = org.slug;
    orgId = org.id;

    const user = await createTestUser({ email: 'distribution-contract@test.example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');
    const oauthClient = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, org.id, oauthClient.client_id)).token;

    const entity = await createTestEntity({ name: 'Alice', organization_id: org.id });
    const otherEntity = await createTestEntity({ name: 'Bob', organization_id: org.id });
    entityId = entity.id;

    await createTestConnectorDefinition({
      key: 'distribution-contract-connector',
      name: 'Distribution Contract Connector',
      organization_id: org.id,
    });
    const connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'distribution-contract-connector',
      entity_ids: [entity.id],
    });

    await sql`
      INSERT INTO entity_identities (organization_id, entity_id, namespace, identifier)
      VALUES (${org.id}, ${entity.id}, 'email', 'alice@example.com')
    `;

    // Legacy attribution: entity_ids contains Alice, but occurred_at is NULL;
    // the endpoint should fall back to created_at for bucketing.
    const undated = await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      content: 'Undated Alice event.',
      occurred_at: new Date('2025-06-01T10:00:00Z'),
      organization_id: org.id,
    });
    await sql`
      UPDATE events
      SET occurred_at = NULL, created_at = ${new Date('2025-06-01T10:00:00Z')}
      WHERE id = ${undated.id}
    `;

    // Identity attribution: entity_ids is empty, but metadata.email matches a
    // live entity_identities row for Alice.
    await createTestEvent({
      entity_ids: [],
      connection_id: connection.id,
      content: 'Identity-linked Alice event.',
      occurred_at: new Date('2025-06-02T10:00:00Z'),
      organization_id: org.id,
      metadata: { email: 'alice@example.com' },
    });

    await createTestEvent({
      entity_ids: [],
      connection_id: connection.id,
      content: 'Unrelated email event.',
      occurred_at: new Date('2025-06-03T10:00:00Z'),
      organization_id: org.id,
      metadata: { email: 'carol@example.com' },
    });
    await createTestEvent({
      entity_id: otherEntity.id,
      connection_id: connection.id,
      content: 'Bob event, not Alice.',
      occurred_at: new Date('2025-06-04T10:00:00Z'),
      organization_id: org.id,
    });
  });

  async function distributionByDate() {
    const response = await get(`/api/${orgSlug}/entities/${entityId}/content-distribution`, {
      token,
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      distribution: Array<{ date: string; count: number }>;
    };
    return Object.fromEntries(body.distribution.map((row) => [row.date, row.count]));
  }

  it('counts entity_ids matches, identity-link matches, and created_at fallback only', async () => {
    const byDate = await distributionByDate();

    expect(byDate['2025-06-01']).toBe(1);
    expect(byDate['2025-06-02']).toBe(1);
    expect(byDate['2025-06-03']).toBeUndefined();
    expect(byDate['2025-06-04']).toBeUndefined();
    expect(Object.values(byDate).reduce((sum, count) => sum + count, 0)).toBe(2);
  });

  it('does not match events through soft-deleted identity links', async () => {
    const sql = getTestDb();
    await sql`
      UPDATE entity_identities
      SET deleted_at = NOW()
      WHERE organization_id = ${orgId}
        AND entity_id = ${entityId}
        AND namespace = 'email'
        AND identifier = 'alice@example.com'
    `;

    const byDate = await distributionByDate();
    expect(byDate['2025-06-01']).toBe(1);
    expect(byDate['2025-06-02']).toBeUndefined();
    expect(Object.values(byDate).reduce((sum, count) => sum + count, 0)).toBe(1);
  });
});
