import { beforeAll, describe, expect, it } from 'vitest';
import { ClientSdkActionError } from '../../../sandbox/namespaces/action-call';
import { cleanupTestDatabase } from '../../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

describe('manage_feeds create_feed capability contract', () => {
  let owner: TestApiClient;
  const connections = new Map<string, number>();

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Feed Capability Create' });
    const user = await createTestUser({ email: 'feed-capability-create@test.com' });
    owner = await TestApiClient.for({
      organizationId: org.id,
      userId: user.id,
      memberRole: 'owner',
    });

    for (const [key, operations] of [
      ['read-only', ['read']],
      ['sync-only', ['sync']],
      ['hybrid', ['sync', 'read']],
    ] as const) {
      const connectorKey = `test.${key}`;
      await createTestConnectorDefinition({
        key: connectorKey,
        name: key,
        organization_id: org.id,
        feeds_schema: {
          items: {
            key: 'items',
            name: 'Items',
            operations: [...operations],
            configSchema: {
              type: 'object',
              properties: { query: { type: 'string' } },
              additionalProperties: false,
            },
          },
        },
      });
      const connection = await createTestConnection({
        organization_id: org.id,
        connector_key: connectorKey,
        created_by: user.id,
        createDefaultFeed: false,
      });
      connections.set(key, Number(connection.id));
			if (key === 'hybrid') {
				const validationConnection = await createTestConnection({
					organization_id: org.id,
					connector_key: connectorKey,
					created_by: user.id,
					createDefaultFeed: false,
				});
				connections.set('hybrid-validation', Number(validationConnection.id));
			}
    }
  });

  it('derives read-only operations and rejects sync scheduling', async () => {
    const error = await owner.feeds
      .create({
        connection_id: connections.get('read-only')!,
        feed_key: 'items',
        schedule: '0 * * * *',
      })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ClientSdkActionError);
    expect(String(error)).toMatch(/does not support sync/i);

    const result = (await owner.feeds.create({
      connection_id: connections.get('read-only')!,
      feed_key: 'items',
      config: { query: 'open' },
    })) as { feed?: Record<string, unknown> };

    expect(result.feed).toMatchObject({
      operations: ['read'],
      store: 'events',
      schedule: null,
      next_run_at: null,
    });
    expect(result.feed).not.toHaveProperty('kind');
    expect(result.feed).not.toHaveProperty('virtual');

  });

  it('allows schedules for sync-only and hybrid feeds', async () => {
    for (const key of ['sync-only', 'hybrid']) {
      const result = (await owner.feeds.create({
        connection_id: connections.get(key)!,
        feed_key: 'items',
        schedule: '0 * * * *',
      })) as { feed?: Record<string, unknown> };
      expect(result.feed?.operations).toEqual(
        key === 'hybrid' ? ['sync', 'read'] : ['sync'],
      );
      expect(result.feed?.schedule).toBe('0 * * * *');
    }
  });

  it('validates the full config for every capability combination', async () => {
    const error = await owner.feeds
      .create({
        connection_id: connections.get('hybrid-validation')!,
        feed_key: 'items',
        config: { query: { invalid: true } as unknown as string },
      })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ClientSdkActionError);
    expect(String(error)).toContain('query');
  });
});
