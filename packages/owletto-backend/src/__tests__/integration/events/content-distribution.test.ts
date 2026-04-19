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

describe('Content distribution API', () => {
  let org: Awaited<ReturnType<typeof createTestOrganization>>;
  let user: Awaited<ReturnType<typeof createTestUser>>;
  let token: string;
  let entity: Awaited<ReturnType<typeof createTestEntity>>;
  let connection: Awaited<ReturnType<typeof createTestConnection>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    org = await createTestOrganization({ name: 'Timeline Test Org' });
    user = await createTestUser({ email: 'timeline-test@example.com' });
    await addUserToOrganization(user.id, org.id, 'owner');

    const client = await createTestOAuthClient();
    token = (await createTestAccessToken(user.id, org.id, client.client_id)).token;

    entity = await createTestEntity({
      name: 'OpenClaw',
      organization_id: org.id,
    });

    await createTestConnectorDefinition({
      key: 'timeline-test-connector',
      name: 'Timeline Test Connector',
      organization_id: org.id,
    });

    connection = await createTestConnection({
      organization_id: org.id,
      connector_key: 'timeline-test-connector',
      entity_ids: [entity.id],
    });
  });

  it('falls back to created_at when occurred_at is null', async () => {
    const db = getTestDb();
    const createdAt = new Date('2025-02-10T15:30:00.000Z');

    const event = await createTestEvent({
      entity_id: entity.id,
      connection_id: connection.id,
      content: 'Undated content should still appear in the timeline.',
      title: 'Undated Event',
      occurred_at: createdAt,
    });

    await db`
      UPDATE events
      SET occurred_at = NULL, created_at = ${createdAt}
      WHERE id = ${event.id}
    `;

    const response = await get(`/api/${org.slug}/entities/${entity.id}/content-distribution`, {
      token,
    });

    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      distribution: Array<{ date: string; count: number }>;
    };

    expect(body.distribution).toEqual([{ date: '2025-02-10', count: 1 }]);
  });
});
