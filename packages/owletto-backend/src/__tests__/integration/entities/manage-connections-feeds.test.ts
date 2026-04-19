/**
 * Manage Feeds Lifecycle Integration Tests
 *
 * Verifies feed CRUD/trigger behavior via the manage_feeds tool.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { cleanupTestDatabase, getTestDb } from '../../setup/test-db';
import {
  addUserToOrganization,
  createTestAccessToken,
  createTestConnection,
  createTestConnectorDefinition,
  createTestEntity,
  createTestOAuthClient,
  createTestOrganization,
  createTestUser,
  seedSystemEntityTypes,
} from '../../setup/test-fixtures';
import { mcpListTools, mcpToolsCall } from '../../setup/test-helpers';

describe('Manage Feeds - Feed Actions', () => {
  let tokenA: string;
  let tokenB: string;
  let orgA: Awaited<ReturnType<typeof createTestOrganization>>;
  let orgB: Awaited<ReturnType<typeof createTestOrganization>>;
  let connectionA: Awaited<ReturnType<typeof createTestConnection>>;
  let connectionB: Awaited<ReturnType<typeof createTestConnection>>;
  let entityA: Awaited<ReturnType<typeof createTestEntity>>;

  beforeAll(async () => {
    await cleanupTestDatabase();
    await seedSystemEntityTypes();

    orgA = await createTestOrganization({ name: 'Feeds Org A' });
    orgB = await createTestOrganization({ name: 'Feeds Org B' });

    const userA = await createTestUser({ email: 'feeds-org-a@test.com' });
    const userB = await createTestUser({ email: 'feeds-org-b@test.com' });

    await addUserToOrganization(userA.id, orgA.id, 'owner');
    await addUserToOrganization(userB.id, orgB.id, 'owner');

    const client = await createTestOAuthClient();
    tokenA = (await createTestAccessToken(userA.id, orgA.id, client.client_id)).token;
    tokenB = (await createTestAccessToken(userB.id, orgB.id, client.client_id)).token;

    await createTestConnectorDefinition({
      key: 'test.feed.connector',
      name: 'Test Feed Connector',
      version: '1.0.0',
      feeds_schema: {
        threads: { description: 'Thread feed' },
        mentions: { description: 'Mentions feed' },
      },
      organization_id: orgA.id,
    });

    entityA = await createTestEntity({ name: 'Feed Entity A', organization_id: orgA.id });
    const entityB = await createTestEntity({ name: 'Feed Entity B', organization_id: orgB.id });

    connectionA = await createTestConnection({
      organization_id: orgA.id,
      connector_key: 'test.feed.connector',
      entity_ids: [entityA.id],
      status: 'active',
    });

    connectionB = await createTestConnection({
      organization_id: orgB.id,
      connector_key: 'test.feed.connector',
      entity_ids: [entityB.id],
      status: 'active',
    });
  });

  it('exposes manage_feeds and manage_auth_profiles as separate tools', async () => {
    const list = await mcpListTools({ token: tokenA });
    const names = list.tools.map((tool) => tool.name);

    expect(names).toContain('manage_connections');
    expect(names).toContain('manage_feeds');
    expect(names).toContain('manage_auth_profiles');
  });

  it('supports create/list/update/get/trigger feed lifecycle', async () => {
    const created = await mcpToolsCall<any>(
      'manage_feeds',
      {
        action: 'create_feed',
        connection_id: connectionA.id,
        feed_key: 'threads',
        entity_ids: [entityA.id],
        config: { language: 'en' },
      },
      { token: tokenA }
    );

    expect(created.action).toBe('create_feed');
    expect(created.feed).toBeDefined();
    expect(created.feed.feed_key).toBe('threads');
    expect(Number(created.feed.connection_id)).toBe(connectionA.id);

    const feedId = Number(created.feed.id);

    const listed = await mcpToolsCall<any>(
      'manage_feeds',
      {
        action: 'list_feeds',
        connection_id: connectionA.id,
      },
      { token: tokenA }
    );

    expect(listed.action).toBe('list_feeds');
    expect(Array.isArray(listed.feeds)).toBe(true);
    expect(listed.feeds.some((f: any) => Number(f.id) === feedId)).toBe(true);

    const updated = await mcpToolsCall<any>(
      'manage_feeds',
      {
        action: 'update_feed',
        feed_id: feedId,
        status: 'active',
        schedule: '* * * * *',
        config: { language: 'tr' },
      },
      { token: tokenA }
    );

    expect(updated.action).toBe('update_feed');
    expect(updated.feed.schedule).toBe('* * * * *');
    expect(updated.feed.config).toBeDefined();

    const triggered = await mcpToolsCall<any>(
      'manage_feeds',
      {
        action: 'trigger_feed',
        feed_id: feedId,
      },
      { token: tokenA }
    );

    expect(triggered.action).toBe('trigger_feed');
    expect(triggered.triggered).toBe(true);
    expect(Number(triggered.feed_id)).toBe(feedId);
    expect(typeof triggered.run_id).toBe('number');

    const duplicateTrigger = await mcpToolsCall<any>(
      'manage_feeds',
      {
        action: 'trigger_feed',
        feed_id: feedId,
      },
      { token: tokenA }
    );

    expect(duplicateTrigger.action).toBe('trigger_feed');
    expect(duplicateTrigger.message).toContain('already pending or running');

    const fetched = await mcpToolsCall<any>(
      'manage_feeds',
      {
        action: 'get_feed',
        feed_id: feedId,
      },
      { token: tokenA }
    );

    expect(fetched.action).toBe('get_feed');
    expect(Number(fetched.feed.id)).toBe(feedId);
    expect(Array.isArray(fetched.recent_runs)).toBe(true);
    expect(fetched.recent_runs.length).toBeGreaterThanOrEqual(1);
  });

  it('enforces organization scoping for feed actions', async () => {
    const createdA = await mcpToolsCall<any>(
      'manage_feeds',
      {
        action: 'create_feed',
        connection_id: connectionA.id,
        feed_key: 'mentions',
      },
      { token: tokenA }
    );

    const createdB = await mcpToolsCall<any>(
      'manage_feeds',
      {
        action: 'create_feed',
        connection_id: connectionB.id,
        feed_key: 'threads',
      },
      { token: tokenB }
    );

    const listA = await mcpToolsCall<any>(
      'manage_feeds',
      {
        action: 'list_feeds',
      },
      { token: tokenA }
    );

    const idsA = new Set(listA.feeds.map((f: any) => Number(f.id)));
    expect(idsA.has(Number(createdA.feed.id))).toBe(true);
    expect(idsA.has(Number(createdB.feed.id))).toBe(false);

    const getCrossOrg = await mcpToolsCall<any>(
      'manage_feeds',
      {
        action: 'get_feed',
        feed_id: Number(createdB.feed.id),
      },
      { token: tokenA }
    );
    expect(getCrossOrg.error).toBe('Feed not found');

    const triggerCrossOrg = await mcpToolsCall<any>(
      'manage_feeds',
      {
        action: 'trigger_feed',
        feed_id: Number(createdB.feed.id),
      },
      { token: tokenA }
    );
    expect(triggerCrossOrg.error).toBe('Feed not found');
  });

  it('prevents duplicate active sync runs under concurrent trigger_feed calls', async () => {
    const sql = getTestDb();

    const created = await mcpToolsCall<any>(
      'manage_feeds',
      {
        action: 'create_feed',
        connection_id: connectionA.id,
        feed_key: 'mentions',
      },
      { token: tokenA }
    );

    const feedId = Number(created.feed.id);

    const [a, b] = await Promise.all([
      mcpToolsCall<any>(
        'manage_feeds',
        { action: 'trigger_feed', feed_id: feedId },
        { token: tokenA }
      ),
      mcpToolsCall<any>(
        'manage_feeds',
        { action: 'trigger_feed', feed_id: feedId },
        { token: tokenA }
      ),
    ]);

    const triggeredCount = [a, b].filter((result) => result.triggered === true).length;
    expect(triggeredCount).toBe(1);

    const activeRuns = await sql`
      SELECT id
      FROM runs
      WHERE feed_id = ${feedId}
        AND run_type = 'sync'
        AND status IN ('pending', 'running')
    `;

    expect(activeRuns.length).toBe(1);
  });
});
