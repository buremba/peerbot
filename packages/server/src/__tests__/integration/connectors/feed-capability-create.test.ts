import { beforeAll, describe, expect, it } from 'vitest';
import { ClientSdkActionError } from '../../../sandbox/namespaces/action-call';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  createTestConnection,
  createTestConnectorDefinition,
  createTestOrganization,
  createTestUser,
} from '../../setup/test-fixtures';
import { TestApiClient } from '../../setup/test-mcp-client';

describe('manage_feeds create_feed capability contract', () => {
  let owner: TestApiClient;
  let organizationId: string;
  let ownerUserId: string;
  const connections = new Map<string, number>();

  beforeAll(async () => {
    await cleanupTestDatabase();
    const org = await createTestOrganization({ name: 'Feed Capability Create' });
    const user = await createTestUser({ email: 'feed-capability-create@test.com' });
    organizationId = org.id;
    ownerUserId = user.id;
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
      if (key === 'hybrid' || key === 'read-only') {
        const extraConnection = await createTestConnection({
          organization_id: org.id,
          connector_key: connectorKey,
          created_by: user.id,
          createDefaultFeed: false,
        });
        connections.set(
          key === 'hybrid' ? 'hybrid-validation' : 'read-only-update',
          Number(extraConnection.id),
        );
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

  it('cannot re-arm a read-only feed through timezone clearing or resume', async () => {
    const sql = getTestDb();
    const created = (await owner.feeds.create({
      connection_id: connections.get('read-only-update')!,
      feed_key: 'items',
    })) as { feed?: { id?: number } };
    const feedId = Number(created.feed?.id);
    expect(feedId).toBeGreaterThan(0);

    await sql`
      UPDATE feeds
      SET schedule = '0 * * * *', timezone = 'UTC', next_run_at = NULL
      WHERE id = ${feedId}
    `;
    const timezoneClear = await owner.feeds
      .update({ feed_id: feedId, timezone: null })
      .catch((reason: unknown) => reason);
    expect(timezoneClear).toBeInstanceOf(ClientSdkActionError);
    expect(String(timezoneClear)).toMatch(/does not support sync cadence/i);

    await sql`UPDATE feeds SET status = 'paused' WHERE id = ${feedId}`;
    const resume = await owner.feeds
      .update({ feed_id: feedId, status: 'active' })
      .catch((reason: unknown) => reason);
    expect(resume).toBeInstanceOf(ClientSdkActionError);
    expect(String(resume)).toMatch(/does not support sync cadence/i);

    const cleared = await owner.feeds.update({
      feed_id: feedId,
      status: 'active',
      schedule: null,
      timezone: null,
    });
    expect(cleared).toMatchObject({
      action: 'update_feed',
      feed: { status: 'active', schedule: null, timezone: null, next_run_at: null },
    });
  });

  it('updates a feed against its exact archived pinned definition', async () => {
    const sql = getTestDb();
    const connectorKey = 'test.pinned-feed-update';
    await createTestConnectorDefinition({
      key: connectorKey,
      name: 'Pinned Feed Update v1',
      version: '1.0.0',
      organization_id: organizationId,
      feeds_schema: {
        items: { key: 'items', operations: ['sync'] },
      },
    });
    const connection = await createTestConnection({
      organization_id: organizationId,
      connector_key: connectorKey,
      created_by: ownerUserId,
      createDefaultFeed: false,
    });
    const created = (await owner.feeds.create({
      connection_id: Number(connection.id),
      feed_key: 'items',
    })) as { feed?: { id?: number } };
    const feedId = Number(created.feed?.id);

    await sql`
      UPDATE connector_definitions
      SET status = 'archived'
      WHERE organization_id = ${organizationId} AND key = ${connectorKey}
    `;
    await createTestConnectorDefinition({
      key: connectorKey,
      name: 'Pinned Feed Update v2',
      version: '2.0.0',
      organization_id: organizationId,
      feeds_schema: {
        replacement: { key: 'replacement', operations: ['sync'] },
      },
    });
    await sql`
      UPDATE feeds SET pinned_version = '1.0.0' WHERE id = ${feedId}
    `;

    const updated = await owner.feeds.update({
      feed_id: feedId,
      display_name: 'Pinned feed still manageable',
    });
    expect(updated).toMatchObject({
      action: 'update_feed',
      feed: {
        id: feedId,
        display_name: 'Pinned feed still manageable',
        operations: ['sync'],
      },
    });
  });
});
